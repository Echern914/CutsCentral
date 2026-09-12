# PR #413 — Send one message to many clients

> This file is the PR description. It lives in the repo because the description
> was rewritten after the implementation changed shape twice, and a stale
> description is worse than none: it is read as a specification.

A shop writes one message and sends it to its whole client book or to one
loyalty group, by **email** or **app notification**. It is on the Clients page.

**Never SMS.** The channel enum has no value for it, so that is not a rule
anybody has to remember: one text to 2,900 clients would empty a month's
texting allowance in a single tap. The screen says so in one line rather than
leaving people hunting for the option.

---

## What pressing "Send" actually does

🔴 **It commits. It does not deliver.**

`POST /api/broadcasts/:id/send` runs **one transaction** and only then answers
`202 { status: "QUEUED", recipients }`:

1. Locks the `Broadcast` row `FOR UPDATE` — the mutex a double-tapped button
   hits, taken before any work.
2. **Re-reads the audience under that lock.** Not the preview's copy: that was
   computed without a lock and may be minutes old.
3. **Reserves the month's email allowance** against a locked `ShopEmailQuota`
   row.
4. **Freezes every recipient** — reachable and skipped alike — into
   `BroadcastSend` rows.
5. Moves `DRAFT → QUEUED` as a compare-and-set.

Any refusal rolls all of it back. There is no half-frozen broadcast, and the
number in the response is a **row count**, not a forecast — so it cannot
disagree with what gets delivered.

The barber is told *"Queued for 412"* and then shown live progress. Not
*"they'll get it"*, which at that instant is a claim about the future dressed
as a receipt — and which a barber watching nothing happen answers by pressing
send again.

## What delivers it

A lease-guarded worker (`broadcast-worker`, every minute, 10-minute lease)
drains the frozen rows. It is the `EmailIntent` outbox pattern field for field,
because it is the same problem and this repo should not have two answers to it.

- **The claim** is one atomic conditional `UPDATE ... FOR UPDATE SKIP LOCKED`,
  capped at a real batch size. A claim older than `CLAIM_TTL_MS` (5 min) is
  treated as abandoned, which is what turns "the process died holding 50 rows"
  into a delay rather than 50 people never written to.
  🔴 The cap had to be *made* real: `LIMIT ${batch}` bound the size as a query
  **parameter**, and the limit was then not applied at all — one pass claimed
  every due recipient across every shop, under a single claim token, for as
  long as the pass took. "Bounded batches" was true in the comment and nowhere
  else. Found by a test that asked for one row and was handed four; the size is
  now inlined as a validated integer.
- 🔴 **Every write after a claim is a compare-and-set on that claim** —
  `(id, status: PENDING, claimToken)`. Not just the success path: refusals,
  backoffs, dry runs, missing clients, digest failures and ambiguous results
  too. A pass claims fifty rows at once with a five-minute TTL inside a
  ten-minute lease, so a worker grinding through a slow batch can still be
  holding row forty when row forty was taken over. The worst outcome is not a
  wrong status — it is `release()` clearing the successor's token, which makes
  a row that is mid-flight elsewhere look unclaimed, so a third pass dispatches
  it and the customer gets the promotion twice. Zero rows moved →
  `stale_claim`, and nothing else happens.
- 🔴 **The claim is refreshed immediately before each provider attempt**, in
  the same atomic statement that reserves the attempt. Without it every row in
  a batch carried the timestamp of the moment the *batch* started, so row forty
  could have less TTL left than its own request needs. The 20s provider timeout
  now sits an order of magnitude inside the 5-minute TTL **per recipient**
  rather than per batch.
- 🔴 **The attempt is reserved, and marked ambiguous, before the request
  leaves.** A process that dies after Resend accepts but before the response is
  handled runs none of the code that would have recorded it — so the fact that
  an attempt may be in flight has to be on disk before it can happen.
- **Email retries carry the stable key `broadcast:<broadcastId>:<clientId>`**,
  so the *provider* collapses them rather than us guessing whether the first
  attempt landed. Past that 24-hour window a row is **ABANDONED unsent** and
  visible: a customer who never hears about a promotion is a smaller harm than
  the same shop mailing them twice.
- **Push has no such key, and is not pretended to.** Its guarantee is weaker
  and named as such: a stable collapse tag, so a repeat *replaces* the earlier
  notification on the device instead of buzzing somebody twice.
- Permanent provider refusals (400/401/403/404/422) stop at one attempt.
  Transient ones (429/5xx/timeout) back off to `MAX_ATTEMPTS`.

## Delivery settlement and bounce correlation are one transaction

🔴 **A bounce used to be able to lose its client for ever.** The worker marked
the recipient `SENT`; `sendEmail` separately started a *floating promise* to
record who that message was for, and swallowed its own failure. Put the
orderings together and the gap is permanent: a bounce arrives first and creates
a delivery row with no `clientId`, the floating write then fails, the webhook is
acknowledged as handled, and nothing will ever connect that bounce to a person.
Nobody is suppressed. The next blast mails the dead address again.

Now one transaction does: claim CAS → `PENDING → SENT` + `messageId` → clear
claim/backoff/ambiguity → upsert `EmailDelivery` with `kind`/`shopId`/`clientId`
→ **never** overwrite a status a webhook already advanced → apply the client's
email suppression right there if what it advanced to was a bounce or complaint.
All of it lands or none of it does.

If that settlement fails, the message *has* been accepted and nothing recorded
it — which is exactly what the ambiguity marker is for. Not `SENT`, still
ambiguous, released on the ordinary backoff, retried under the identical
provider key. Never a fresh logical email.

The transition rules live in **one** transaction-aware helper
(`recordDispatchInTx`) that both the worker and the legacy fire-and-forget
recorder call. The floating recorder stays for other callers — losing a
transactional email's ledger row costs a lookup nobody may ever make — but
broadcast correctness no longer depends on it.

## What it costs, said before the send

**Notifications are free and unmetered.** That is the whole reason the barber is
offered the choice.

**Email is metered**, against a new per-plan monthly allowance separate from the
SMS one — a text costs roughly a hundred times what an email does, so one shared
budget would be wrong in both directions.

🔴 **The allowance is a reservation, not a count of what left.** Counting `SENT`
rows is a check-then-act race with a window minutes wide: two blasts started
seconds apart both read "400 left", both decide they fit, and the shop mails 800
on a 400 allowance — with nothing in the record showing which one overspent. The
reservation is taken against a row locked `FOR UPDATE` inside the freeze
transaction, so the second sender waits, sees the first one's reservation, and
is refused before a single row is written.

A blast is reserved **in full while in flight** (a shop cannot spend the last
400 twice by starting two sends at once), and the **unused remainder is returned
in the same atomic step that gives the broadcast a terminal status**, against
the month the reservation was *taken* in — so a blast queued at 23:59 on the
30th that finishes at 00:05 returns September's allowance to September. A
recipient who was never mailed costs the shop nothing.

Over-allowance is refused **up front**, with both numbers and a nudge toward
notifications. Never 300 sent and then a wall, which cannot be undone or
honestly resumed.

> ⚠️ **The allowance numbers are a pricing decision, not a technical one.**
> Starter 1,000 / Premium 5,000 / Premium AI 20,000 are placeholders, flagged in
> `constants.ts`. They are Eric's to set.

## The barber sees the real number first

"2 of 6 clients will get this", with every exclusion named: no email address,
unsubscribed, **bounced or marked as spam**, hasn't installed the app, not in
the group you picked, archived. A blast that quietly reaches a third of who he
pictured is how a shop concludes the feature is broken.

## This is ChairBack's first marketing email

It is built to be lawful to send rather than retrofitted later.

- **A real one-click unsubscribe**, at a real route, with the `List-Unsubscribe`
  and `List-Unsubscribe-Post` headers Gmail and Yahoo require.
- 🔴 **On a dedicated credential.** The first cut put `Client.magicToken` in the
  footer — that customer's entire rewards session, mailed to thousands every
  time a shop ran a promotion, through forwarding, screenshots, shared inboxes
  and every link scanner in between. What it carries now grants
  `emailOptedOut = true` and nothing else: it cannot open rewards, read an
  appointment, or be exchanged for anything that can. Tests prove both
  directions.
- 🔴 **Signed by `UNSUBSCRIBE_TOKEN_SECRET`, deliberately not `SESSION_SECRET`.**
  Whatever signs these decides how long a link in a three-week-old email keeps
  working, so tying them to the session key tied an unsubscribe's lifetime to a
  value whose entire purpose is to be rotated — and it broke *invisibly*: not at
  rotation, but at each client's next broadcast, when the worker re-derived
  their token and overwrote the stored digest. **Production refuses to boot
  without the dedicated secret**, and refuses it set equal to `SESSION_SECRET`.
  It must be base64 decoding to at least 32 bytes. Development and CI fall back
  once, loudly; a blank value counts as unset so copying `.env.example` works.
  Only the SHA-256 digest is stored, so a leaked backup yields no working links.
- **The shop's postal address in every footer**, and a shop without one is
  refused for email — with a sentence it can fix in a minute — rather than sent
  non-compliantly. Push carries no such duty and is never gated on it. *(Only 3
  of 21 live shops had an address on 2026-09-11, so most will hit this.)*
- **Unsubscribing stops marketing only.** Booking confirmations and reminders
  keep going: somebody who does not want promotions has not asked to stop being
  told when their own appointment is.
- 🔴 **A failed unsubscribe write never claims success.** It answers `503` —
  retryable, so mailbox providers retry the one-click POST — with a page saying
  plainly they are *not* unsubscribed yet. The old behaviour rendered "You're
  unsubscribed" over a swallowed database error; somebody reads that, believes
  it, the next promotion arrives, and they press "this is spam" instead. Every
  token gets one identical answer either way, so the outage cannot be turned
  into an enumeration oracle.

## Three facts, three columns — never merged

| Column | Means |
|---|---|
| `optedOut` | TCPA: they texted STOP |
| `emailOptedOut` | CAN-SPAM: **they chose** to unsubscribe |
| `emailSuppressedAt` + `emailSuppressionReason` | **the provider refused** — bounce, complaint, permanent failure |

Reporting a bounce as an unsubscribe puts a decision in a customer's mouth they
never made, and hands it back to the barber as "47 people unsubscribed".

## Nobody is ever mailed twice

Every intended recipient gets a row before a single message leaves,
`(broadcastId, clientId)` is unique, and the `DRAFT → QUEUED` claim is taken
inside the freeze transaction — so a second press is told **409** rather than
handed a cheerful receipt for work it is not doing.

## Found by the tests, fixed here

RLS alone allowed a `BroadcastSend` pairing **one shop's blast with another
shop's client**: the policy asks "is this row's shopId mine?", and a row stamped
with my shopId and your clientId says yes. Closed with a composite foreign key
`(clientId, shopId) → Client(id, shopId)`, so the database cannot store one.

## Not in this PR

**The assistant cannot send one — deliberately untouched.** MCP `WRITE_SCOPES`
is empty by design. The intended shape is the assistant writing a `DRAFT` and
the barber pressing send, which the data model already supports. That is a
separate change.

Also untouched: the iOS customer portal, `customer.tsx`, and PR #412.

## One thing found here that is NOT fixed here

Three other raw-SQL batch loops bind their limit the same way
`broadcastWorker` did, so their batching is very likely just as inert:

- `apps/api/src/engines/emailOutbox.ts`
- `apps/api/src/engines/affiliateCredit.ts`
- `apps/api/src/services/rewardsRotation.ts`

They are outside this PR and untouched. They deserve the same one-line fix and
the same "asked for one, got four" test — worth a follow-up, because the
consequence there is the same: a pass that claims far more than it intended.

## Operator notes

- **Three migrations**, in order: enum values (isolated — Postgres cannot use a
  new enum value in the transaction that adds it), then columns +
  `ShopEmailQuota` + RLS + **the `job_lease` seed**, then the composite FK.
- **`UNSUBSCRIBE_TOKEN_SECRET` must be set in Railway before deploy** —
  production will not boot without it. `openssl rand -base64 32`.
- The mobile app needs no build for this; it is web + API only.

## Verification

Run at `150a305` + this change, on a local Postgres.

| Suite | Result |
|---|---|
| Broadcast + unsubscribe (9 files, targeted) | **145 passing**, 0 failing |
| API, full suite (`apps/api`) | **3,506 passing**, 5 failing (all pre-existing/contention, below) |
| `packages/db` (tenant/RLS) | **53 passing**, 0 failing |
| `packages/config` | **491 passing**, 1 failing (pre-existing, below) |
| Typecheck: api / config / db | clean |
| Web production build | `✓ Compiled successfully` |
| Web typecheck | 160 — unchanged from this PR's previous state |

🔴 **This repository is not fully green, and these failures are not from this
PR:**

- `packages/config` → `vocabularyLint.test.ts` fails on **`main`**:
  `apps/mobile/app/customer.tsx:366` ("Fades By Mikey Barbershop"), which
  arrived with PR #412. Out of scope here by instruction.
- `apps/api` → `receptionistNumberPublic.test.ts` fails identically on the
  pre-change baseline (local-env).
- Full-suite API failures **pass in isolation**. Across six full runs the
  failing set has been different every time (`staffUserLink`,
  `waitlistClientFlow`, `cardOnFileSettle`, `booking.checkin`,
  `shops.businessType`, `walkIn.dashboard`, `appointmentRequests`, `authMobile`,
  `ledgerEdit`, `bookingErrorCodes`, `rewardsRotationRoute`,
  `stripeConnect.oauth`), typically cascading from a `beforeAll` that could not
  create its fixture. That is shared-database contention across 300 files, not a
  regression — but it does mean a single full run cannot be read as a clean
  signal.
