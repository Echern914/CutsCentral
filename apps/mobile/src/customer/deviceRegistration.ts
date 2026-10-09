/**
 * Registering this phone for push from the customer's shops - retried until
 * it lands, never twice at once, and never for a signed-out account.
 *
 * 🔴 WHAT WAS WRONG. Registration ran once per launch and marked itself done
 * BEFORE asking iOS for a token. A customer who turned notifications back on
 * in Settings saw Profile say "On" while the phone was never registered, and
 * nothing arrived until iOS happened to kill the app. A failed POST was also
 * swallowed for the rest of the launch.
 *
 * Now: an attempt runs on mount and on every return to the foreground, and the
 * phone counts as registered only once the server has said so. One attempt at
 * a time (a foreground during an attempt joins it). The server upserts by
 * token, so even a retry of an answer that was lost can't make a duplicate.
 *
 * Sign-out calls `stop()` first: no new attempt starts, the one in flight is
 * waited for, and the token it used is handed back to be unregistered - even
 * if its answer was lost - so a slow registration can't land after the
 * sign-out and leave a signed-out phone hearing from the shops.
 */

export type AttemptOutcome = "registered" | "already" | "no_token" | "failed" | "skipped";

export interface DeviceRegistrar {
  /** Try now (mount, foreground). Joins an attempt already running. */
  attempt(): Promise<AttemptOutcome>;
  /**
   * Stop for sign-out: no new attempts, wait for the current one, and return
   * the token this phone may be registered under (null if it never got one).
   */
  stop(): Promise<string | null>;
  /** A new sign-in: attempts may run again, for the new account. */
  resume(): void;
}

export function createDeviceRegistrar(deps: {
  /** iOS's push token, or null (no permission, simulator, OS refused). */
  getToken: () => Promise<string | null>;
  /** POST the token; throws when the server did not confirm it. */
  register: (token: string) => Promise<void>;
  /** A signed-in, non-demo customer right now. */
  canRegister: () => boolean;
}): DeviceRegistrar {
  let inFlight: Promise<AttemptOutcome> | null = null;
  let stopped = false;
  /** Confirmed by the server for this sign-in. */
  let registered: string | null = null;
  /** The last token sent, confirmed or not - what sign-out must unregister. */
  let tried: string | null = null;

  async function run(): Promise<AttemptOutcome> {
    if (stopped || !deps.canRegister()) return "skipped";
    const token = await deps.getToken();
    if (!token) return "no_token";
    // Asking iOS can take a while (the permission prompt): re-check.
    if (stopped || !deps.canRegister()) return "skipped";
    if (registered === token) return "already";
    tried = token;
    try {
      await deps.register(token);
    } catch {
      return "failed"; // the next foreground tries again
    }
    registered = token;
    return "registered";
  }

  return {
    attempt() {
      if (!inFlight) {
        inFlight = run()
          .catch((): AttemptOutcome => "failed")
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
    async stop() {
      stopped = true;
      if (inFlight) await inFlight;
      const token = registered ?? tried;
      registered = null;
      tried = null;
      return token;
    },
    resume() {
      stopped = false;
      registered = null;
      tried = null;
    },
  };
}
