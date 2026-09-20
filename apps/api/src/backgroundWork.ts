/**
 * A drain for fire-and-forget work, so a test can KNOW nothing of its own is
 * still running when it ends.
 *
 * 🔴 THE BUG THIS EXISTS FOR. Booking routes dispatch notifications with
 * `void notifyBarberBookingEvent(...)` - deliberately, because a customer must
 * not wait on an SMS to get their confirmation. The route therefore returns
 * BEFORE the barber's push and SMS have been sent, and a test that asserts on
 * the response has no idea whether the notification has happened yet.
 *
 * Tests worked around that by polling for the effect they cared about:
 *
 *     await waitFor(() => pushes.length > 0);   // waits for the PUSH
 *     expect(sent.map((s) => s.to)).not.toContain(BARBER_PHONE);  // asserts SMS
 *
 * Push and SMS are two independent legs of the same dispatch. Waiting for one
 * says nothing about the other, so the test finished with an SMS still in
 * flight. `beforeEach` then cleared the capture array, the straggler landed in
 * the NEXT test's array, and that test failed on a message it never caused -
 * which is exactly how `staffUserLink.test.ts > falls back to the owner for a
 * chair nobody holds` went red in CI while passing on every developer machine.
 *
 * 🔴 WHY POLLING HARDER IS NOT THE FIX. "Wait for the owner SMS too" fixes the
 * one assertion and leaves the mechanism: any leg nobody happens to assert on
 * is still free to arrive late, and the next failure lands in a different file
 * on a different day. Quiescence has to be a fact, not a guess about timing, so
 * this counts the dispatches instead of waiting on their effects.
 *
 * 🔴 INERT IN PRODUCTION. Untracked (the default, and always the case outside a
 * test), `trackBackgroundWork` returns the promise it was handed and allocates
 * nothing. Tracking is armed explicitly by a test and disarmed after it.
 */

/** Non-null only while a test has armed tracking. */
let inFlight: Set<Promise<void>> | null = null;

/**
 * Register a fire-and-forget promise, if a test is watching.
 *
 * Returns the ORIGINAL promise, so callers - including `void f()` - behave
 * identically whether or not tracking is armed.
 */
export function trackBackgroundWork<T>(work: Promise<T>): Promise<T> {
  const set = inFlight;
  if (!set) return work;
  // A settled-either-way handle: the caller owns the real outcome, and a
  // rejection here must not surface as an unhandled rejection in the drain.
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  set.add(settled);
  void settled.then(() => set.delete(settled));
  return work;
}

/** Start watching. Call once per suite, before anything can dispatch. */
export function armBackgroundWorkTracking(): void {
  inFlight = new Set();
}

/** Stop watching, and forget anything outstanding. */
export function disarmBackgroundWorkTracking(): void {
  inFlight = null;
}

/** How many dispatches are still running. For assertions about the drain itself. */
export function backgroundWorkInFlight(): number {
  return inFlight?.size ?? 0;
}

/** How long a drain may wait in total before giving up and failing the test. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wait until no tracked work remains.
 *
 * 🔴 LOOPS, because settling one dispatch can start another - a notify that
 * awaits a database read and only then sends. Draining once would return with
 * the second leg newly in flight, which is the whole failure mode again.
 *
 * 🔴 `allSettled`, NOT `all`. A notification that rejects is a normal thing -
 * a provider is down, a push subscription is stale - and it must still count as
 * finished. With `Promise.all` the first rejection would abandon the drain with
 * other dispatches still running, which is the leak this file exists to close,
 * reached by a different route.
 *
 * 🔴 BOUNDED IN TIME, NOT IN ITERATIONS. An earlier version bounded the number
 * of ROUNDS, which bounds nothing: a promise that never settles hangs inside the
 * first round forever, and the loop counter is never reached. The deadline below
 * is what actually stops a stuck dispatch from hanging the run, and it fails the
 * test that owns it with a message naming the problem rather than surfacing as a
 * mystery hook timeout.
 */
export async function settleBackgroundWork(
  opts: { timeoutMs?: number; rounds?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rounds = opts.rounds ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (let i = 0; i < rounds; i++) {
    const set = inFlight;
    if (!set || set.size === 0) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.allSettled([...set]).then(() => "drained" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      }),
    ]);
    // Always clear it: a live timer keeps the event loop busy and would make
    // every drain cost `remaining` even after it succeeded.
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") break;

    // Yield, so anything queued by that settling is registered before we look
    // again. Without this the set can read empty while a continuation that is
    // about to dispatch has not run yet.
    await new Promise((r) => setTimeout(r, 0));
  }

  const stuck = backgroundWorkInFlight();
  if (stuck > 0) {
    throw new Error(
      `background work did not settle within ${timeoutMs}ms (${stuck} still in flight). ` +
        `A dispatch is hanging - find it rather than raising this bound.`,
    );
  }
}
