# Square calendar protection

Mirroring ChairBack occupancy **out** to Square, so a Square customer can no
longer buy a chair ChairBack already sold.

This is the same incident Acuity's outbound mirror fixed on 2026-08-25, against
an API that makes it considerably harder.

---

## Why this is not "the Acuity blocks code, for Square"

Acuity has blocked time: one calendar id per chair, `POST /blocks`, done.

**Square has no equivalent.** No `BLOCKED` status, no block entity, and
`customer_id` is not optional on a Booking. Protection therefore has to be a
**real Square Booking** created through the Bookings API — which means a mirror
needs three things Acuity never did:

| | |
|---|---|
| `location_id` | Bookings are location-scoped. |
| `team_member_id` | Which human's day this lands on. |
| `service_variation_id` **+ version** | Square rejects a booking whose `service_variation_version` is behind the catalog. |

…and two things can be true of a seller that make **every** write fail no matter
how good the mapping is:

- the token was never granted `APPOINTMENTS_WRITE` / `APPOINTMENTS_ALL_WRITE` —
  the state **every existing connection is in**, because the original connect
  asked for read scopes only;
- the seller's plan does not support seller-level writes (Square refuses them
  below Appointments Plus).

All five are checked together, before anyone can arm enforcement, so the failure
lands on a setup screen instead of on a real customer's booking.

---

## The three PRs

| | | |
|---|---|---|
| **S1** | Foundation | Mode, mappings, staleness, capability check, setup UI. **No Square write of any kind.** |
| **S2** | Durable mirroring | `SquareOutboundBooking` + a webhook inbox ledger, wired into every appointment path. |
| **S3** | Rehearsal, backfill, rollback | OBSERVE report, bounded backfill, coverage report, release-all. |

**S2 must not be written until the sandbox contract below passes.** Every one of
its fourteen questions changes S2's design, and none can be settled from
documentation.

---

## 🔴 The blocker: no sandbox credentials exist

The contract cannot be run yet. Railway holds only **production** Square
credentials:

```
SQUARE_ENV = production
SQUARE_OAUTH_CLIENT_ID, SQUARE_OAUTH_CLIENT_SECRET,
SQUARE_OAUTH_REDIRECT_URI, SQUARE_WEBHOOK_SIGNATURE_KEY
```

Running the contract with those would write real bookings into a real seller's
calendar. It needs a **sandbox** token instead:

> Square Developer Console → your app → **Sandbox** → open the test account →
> **Credentials** → *Sandbox Access token* (starts `EAAA…`)

Then:

```bash
SQUARE_SANDBOX_ACCESS_TOKEN=EAAA... \
pnpm --filter @chairback/api exec tsx scripts/square-sandbox-contract.ts
```

The script refuses to run against production twice over: the host is hard-coded
to `connect.squareupsandbox.com`, and a token that is not a sandbox token is
rejected before the first request. It cleans up every booking and customer it
creates, and prints their ids either way.

**Sandbox seller prerequisites** — without these the contract skips its most
important half:

1. an **Appointments Plus or Premium** sandbox seller (otherwise
   `support_seller_level_writes` is `false` and C7–C13 exercise a plan that
   cannot do what S2 needs);
2. at least one team member with online booking enabled;
3. at least one catalog item whose `product_type` is `APPOINTMENTS_SERVICE`.

---

## The contract

Twelve automated, two manual, plus three webhook legs that need a tunnel.

| | Question | Why it changes the design |
|---|---|---|
| C1 | Is `support_seller_level_writes` reported? | It is the arming gate. A missing field must read as *unsupported*. |
| C2 | Can we enumerate and select a location? | Outbound must never inherit the "first active location" the inbound connect picked. |
| C3 | Are bookable team-member profiles returned? | A non-bookable member stores a mapping that reads valid and fails at write time. |
| C4 | Do service items carry variations **with a version**? | No version, no usable mapping. |
| C5 | Can we mint the customer a Booking requires? | Square has no block entity; a mirror needs a customer record. **Whether that is one reusable "ChairBack hold" customer or a per-client record is an S2 decision this informs.** |
| C6 | Can we confirm a slot is free before writing? | The only mitigation available if C10 fails. |
| C7 | Does a seller-level write land? | Everything downstream depends on it. |
| C8 | Does it land `ACCEPTED`, or sit `PENDING`? | **A `PENDING` booking is not protection.** The time is not held until a human accepts, so a mirror producing PENDING rows would advertise protection it does not deliver. |
| C9 | Does replaying an idempotency key produce **one** booking? | Decides whether a lost create response is recoverable by replay, or whether S2 needs Acuity-style recovery-by-reference. |
| C10 | Does a seller-level write **reject** an overlap? | **The most important question here.** Square's docs say seller-level writes *can* double-book while buyer-level writes cannot. If Square accepts the overlap there is no atomic collision rejection, and S2 must re-verify availability immediately before writing and **document the unavoidable cross-system race rather than claim atomic parity.** |
| C11 | Does a versioned `UpdateBooking` reschedule in place? | If yes, S2 uses it — **do not copy Acuity's create-then-delete swap** when Square offers a stronger atomic operation. |
| C12 | Is a **stale** version rejected? | If not, the version is not an optimistic-concurrency guard and cannot be relied on. |
| C13 | Does cancel with the correct version release the time? | The rollback leg. |
| C14 | Does Square email/SMS the **customer** for a seller-level API booking? | **Manual.** A mirror that texts a stranger "your appointment is confirmed" for a hold they never made is a worse bug than the double-booking. |
| W1 | `booking.created` payload shape + a stable `event_id` | The inbox ledger's primary key. |
| W2 | `booking.updated` on reschedule **and** on cancel | Square has no separate cancel event. |
| W3 | Does an **app-origin** booking import as a second Visit? | Self-echo. It must confirm the outbound row, never create a Visit. |

W1–W3 need the sandbox webhook pointed at a tunnel; they cannot be driven from a
script.

---

## What S2 shipped — and how it survives the contract being unrun

The sandbox contract still has not been run (no sandbox token was available).
S2 is therefore written to be **correct under either answer to C8 and C10**,
which is a better engineering position than branching on them anyway:

| Contract question | How S2 handles it without the answer |
|---|---|
| **C8** ACCEPTED or PENDING? | Read from Square's **actual response** on every write. `interpretBookingStatus` treats **only `ACCEPTED`** as protection; `PENDING` becomes `awaiting_seller`, the public booking answers **202 processing** rather than "you're booked", and the row records what Square said. An unrecognised status is *not held* — under-claiming costs a line on a report, over-claiming costs a double booking. |
| **C9** does the idempotency key hold? | The key is minted once at intent time and **never regenerated**. Every retry and every reconcile replays it. If Square honours it, a lost response costs nothing; if it does not, the `UNKNOWN` state and the reconciler still bound the damage. |
| **C10** are overlaps rejected? | Assume they are **not**. Before every create the engine asks Square what is already on that team member's calendar for that span and **refuses rather than write over a human being**. This narrows the race to one round trip. **It does not close it** — another booking can land between the check and the create — and nothing in the code or the UI claims otherwise. |
| **C11/C12** versioned update? | Reschedule uses **`UpdateBooking` with the current version**, re-read immediately before the call. Not Acuity's create-then-delete swap: Square offers an atomic operation and using the weaker pattern would invent a window where the chair is blocked twice or not at all. A definitive refusal leaves the row at the **old** span, which keeps the old time held. |
| **C13** versioned cancel? | Cancel re-reads the booking for its current version first — a seller who edited it in Square moved the version, and a stale one is rejected. A failed cancel leaves the row `RELEASING`, so the time stays blocked until we can prove it is gone. |

**The conflict check uses `ListBookings`, not `SearchAvailability`,** for the
blocking decision. Availability is shaped by the seller's own booking rules
(business hours, lead time, cutoffs), so "not available" routinely means
"outside your Square hours" for a shop whose ChairBack hours are wider — which
would fail every early appointment for something that is not a conflict. An
overlapping `ACCEPTED`/`PENDING` booking is unambiguous. The availability probe
still runs immediately before the write, logged rather than blocking.

### Wiring: every appointment path, no call-site changes

The Square legs live **inside** `recordMirrorIntent`, `dispatchAfterCommit`,
`releaseForAppointment` and `completeReschedule`. Every path that already
mirrors to Acuity — public booking, dashboard create, approval requests,
recurring series, waitlist claim, receptionist, gap-fill, walk-in, reschedule,
cancel, decline, no-show — therefore mirrors to Square without an edit of its
own. Wiring eight call sites twice is eight chances to wire one of them once.

Two deliberate exceptions:

- `swapForReschedule` records an **Acuity-only** intent, because Square moves in
  place. Recording a second live Square row there would also collide with the
  one-live-mirror-per-appointment index and take the booking transaction down.
- `booking.public.ts` calls the Square dispatch **explicitly and first**, because
  that path is fail-closed: it must be able to compensate the appointment before
  anything is promised, and a Square conflict is the one failure that means
  somebody else already has the chair.

### 🔴 SquareConnection and FORCE RLS — measured, not assumed

`squareConnectionRls.test.ts` runs the experiment inside rolled-back
transactions (Postgres makes DDL transactional) and establishes:

1. A non-superuser role **already sees zero rows** — `ENABLE` with no policy is
   default-deny, so the Supabase data-API hole is closed. FORCE adds nothing.
2. The app reads the table only because it connects as a **superuser**, which
   bypasses RLS with or without FORCE. On this deployment FORCE is a **no-op**.
3. FORCE with **no policy** makes the table unreadable by any non-superuser — so
   the day the app stops connecting as one, every token lookup returns nothing
   and Square goes dark with no error that mentions RLS. FORCE alone is a latent
   outage, not a hardening.
4. FORCE **+ a shopId policy** works for shop-scoped reads…
5. …but **breaks the webhook**, which resolves merchant → shop with no shop
   context to scope by. Measured: zero rows, meaning every inbound Square event
   would be dropped as "unknown merchant" while returning 200.

**Conclusion:** FORCE is safe only together with a policy *and* moving the
merchant → shop resolution outside RLS. Until S3 does that, `ENABLE`-only is
correct — and now that is a test rather than a comment. `SquareOutboundBooking`,
which is genuinely per-shop with no merchant lookup, takes the full
`ENABLE + FORCE + policy` posture.

## What S1 shipped

**Schema.** `SquareOutboundMode` (OFF/OBSERVE/ENFORCE, default OFF) ·
`SquareConnection.connectionGeneration` / `grantedScopes` / `sellerLevelWrites` /
`bookingEnabled` / `outboundLocation*` · `Staff.squareTeamMemberId` +
mapped-at/generation · `Service.squareServiceVariationId` + version +
mapped-at/generation · one partial unique index (**one team member, one chair**).

**Staleness is a counter, not a timestamp.** The inbound OAuth callback's upsert
never touched `connectedAt` on its UPDATE branch, so a reconnected row still
carries its original timestamp — a timestamp comparison would call a mapping
*fresh* that was made against a different merchant. `connectionGeneration`
increments on every completed callback; a mapping stamped with any other
generation is stale, and a `null` generation is stale too (it cannot prove which
merchant it referred to).

**The write scopes are opt-in.** `SQUARE.scope` (read-only) stays the default for
the ordinary connect; `SQUARE.outboundScope` is requested only via
`/api/square/oauth/start?outbound=1`. Widening the default would change the
consent screen every seller sees, for a capability most of them are not on a
Square plan to use — and a connect flow that fails is a worse regression than a
feature nobody armed. The choice rides in the **signed** OAuth state so the
callback cannot be lied to about which consent screen was shown.

**ENFORCE is gated on the PAIR, not the barber.** A perfectly mapped chair still
cannot be protected for a service that is not in Square's catalog.

**A barber hired after arming is refused, alone.** The arming gate cannot cover
someone who arrives later. Taking the booking would sell time Square is still
offering; disarming the shop would strip protection from everyone who *is*
mapped. So that one pair is refused, the manager gets an immediate warning naming
it, and the guard answers **from the database alone** — the public booking path
must not start failing because Square is down.

**S1 cannot write to Square.** The client exposes no create/update/cancel at all;
a test asserts those methods are `undefined`. The only non-GET is OAuth token
introspection, which is the sole way to learn what a token was actually granted.

---

## What the existing Square integration got wrong

Found while auditing against `origin/main`, all still true at `9a48971`:

| | |
|---|---|
| `scope` recorded the **request**, not the grant | `ObtainToken` does not echo scopes; the column was `SQUARE.scope` verbatim. **S1 fixes this** via `RetrieveTokenStatus`. |
| OAuth picked the **first active location** | Fine for reading a single-location seller, unacceptable for writing. **S1 adds an explicit outbound location.** |
| No `Staff` → team-member or `Service` → variation mapping | **S1 adds both.** |
| Read-only scopes | **S1 adds the opt-in wider set.** |
| The webhook does not persist or dedupe `event_id` | Relies on Visit upsert idempotency, which cannot dedupe *work* — only rows. **S2.** |
| `ingest.ts` reads only `appointment_segments[0]` | A multi-segment booking's true span is under-counted. **S2.** |
| `ingest.ts` defaults a missing duration to 30 minutes | A silent guess that decides whether a slot is offered. **S2 must record a sync-health error and conservatively withhold availability instead.** |
| Concurrent 401s can overwrite a rotated refresh token | Two refreshes race and the loser persists a dead token. **S2 (compare-and-set or a lease).** |
