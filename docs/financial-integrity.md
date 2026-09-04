# Financial integrity

The money paths in ChairBack, what protects each one, what proves it, and what
is still not proven. Written from the 2026-09-03 audit; keep it current when a
money path changes - a stale row here is worse than none, because someone will
trust it.

Start of the audit: `origin/main` at `a6c4177d296707a72abd4eca74447c94e03e7c74`.

## The shape of the money

Two separate businesses run through one Stripe account:

1. **Platform subscriptions** - ChairBack bills the *shop* (Premium, Premium AI,
   the receptionist add-on) through Stripe Billing: subscription-mode Checkout
   Sessions, the hosted Customer Portal, and the `/webhooks/stripe` endpoint.
   Prices live in Stripe; the code holds only their ids (`STRIPE_PRICE_ID`,
   `STRIPE_PREMIUM_AI_PRICE_ID`, `STRIPE_RECEPTIONIST_PRICE_ID`).
2. **Customer payments** - a *customer* pays a *shop* for a booking through
   Stripe Connect, as **destination charges** created on the platform account
   with `on_behalf_of` + `transfer_data.destination` naming the shop's
   connected account. The shop is the merchant of record. There are no
   separate transfers, no platform-initiated payouts, and the platform fee
   (`Shop.platformFeeBps`) is 0 for every shop today. Three flavours: pay ahead
   / deposit (a PaymentIntent the customer confirms in the browser), card on
   file (a SetupIntent at booking, a later off-session PaymentIntent for a
   no-show or late-cancel fee), and Terminal (a card-present intent for Tap to
   Pay; server half only).

Two reward programs credit a *shop's* Stripe customer balance: the **legacy
referral** (one month, on the friend's first paid invoice, live) and the
**affiliate program** (merged, all four flags false, dark).

Stripe SDK `stripe@22.2.0`; no `apiVersion` is passed (`billing/stripe.ts`),
so the SDK's own pinned version applies. The instruction's reference point was
22.4.0 / `2026-07-29.dahlia`; upgrading is deliberately NOT mixed into this
work - it is a separate change with its own proof.

## Money-flow inventory

| Operation | Payer → recipient | Amount source | Currency | Stripe object / API | Local durable record | Idempotency | Confirmation event | Retry | Reconciliation | Authorization | Reversal path | Risk now | Proof |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Base subscription checkout | shop → ChairBack | Stripe Price (`STRIPE_PRICE_ID` / `_PREMIUM_AI_`) | usd | `checkout.sessions.create` mode=subscription | `Shop.stripeCustomerId/SubscriptionId/subscriptionStatus/plan` | key `checkout:<shop>:base:<tier>:<10-min bucket>`; customer key `customer:<shop>` | `checkout.session.completed`, `customer.subscription.*` (ordered by `event.created`) | Stripe retries webhooks; session retry returns the same session | subscription events converge; receipt table | owner/manager (`requireManager`) | Customer Portal cancel; `subscription.deleted` | LOW | `routes/billing.test.ts`, `routes/webhooks.integrity.test.ts` |
| Receptionist add-on checkout | shop → ChairBack | `STRIPE_RECEPTIONIST_PRICE_ID` | usd | `checkout.sessions.create` | `Shop.receptionistSubscriptionStatus` | key `checkout:<shop>:receptionist:<bucket>` | same, on its own clock (`receptionistEventCreated`) | same | same | manager | Portal | LOW | `billing.test.ts` |
| Upgrade Premium → Premium AI | shop → ChairBack | Stripe price swap, `always_invoice` | usd | `subscriptions.update` | `Shop.plan` (optimistic) + webhook | key `upgrade:<sub>:<price>` | `customer.subscription.updated` | same key replays | webhook converges | manager | Portal downgrade | LOW | `billing.test.ts` |
| Pay-ahead / deposit | customer → shop | server: service price / `depositChargeCents` (capped at price) | usd (`validateCharge`) | `paymentIntents.create` destination charge, automatic methods | `Payment` (row BEFORE the call, `pending:` id) | key `pi-create:<paymentId>`; request rebuilt from the row on retry | `payment_intent.succeeded` promotes the PENDING hold (`promotePaidHold` CAS) | same key; reconciler adopts by metadata search | `billing/reconcile.ts` | public route; hold expires if unpaid | `refundForCancellation` (policy fee, `reverse_transfer`, `refund_application_fee`) | LOW | `billing/paymentsRecovery.test.ts`, `deposit.test.ts`, `payments.test.ts` |
| Card on file - keep | customer → (nothing) | n/a | usd | `customers.create` + `setupIntents.create` (`on_behalf_of`, off_session) | `CardOnFile` (FORCE RLS) | keys `cof-customer:<id>`, `seti-create:<id>` | `setup_intent.succeeded` AND server-side retrieve | reuse row/intent | hold lapse releases + detaches | public route | `releaseCardOnFile` detaches | LOW | `billing/cardOnFile.test.ts` |
| Card on file - charge fee | customer → shop | `cardOnFileFeeCents` (shopPolicy) from the ticket, only if `chargeCardOnFileFees` | usd | off-session `paymentIntents.create` confirm | `Payment` (row before the call) + `CardOnFile.status` | CAS `saved→charging` + key `cof-charge:<rowId>` | synchronous response; ambiguous → `ambiguousAt`, reconciler | never retried blind | reconciler (search by metadata) | manager no-show / customer late cancel | `refundForCancellation` | LOW | `services/cardOnFileSettle.test.ts`, `billing/reconcile.test.ts` |
| Terminal (Tap to Pay) | customer → shop | server: ticket | usd (`validateCharge`) | `paymentIntents.create` card_present | `Payment` (row before the call) | key `terminal-pi:<paymentId>` | `payment_intent.succeeded` | same key | reconciler | manager | refund | LOW (mobile half not built) | `financialInvariants.test.ts` |
| Refund on cancellation | shop → customer | `collected - refundedAmount - fee` (server) | usd | `refunds.create` `reverse_transfer` | `Payment.refundedAmount/status` (CAS on the prior total) | key `refund:<paymentId>:<refundedAmount>` | `charge.refunded` (monotonic) | same key replays the one refund | webhook + reconciler | manage token / manager | n/a | LOW | `paymentsRecovery.test.ts`, `payments.test.ts` |
| Legacy referral reward | ChairBack → referrer shop | referrer's own `unit_amount` (never the list price) | usd | `customers.createBalanceTransaction` (negative) | `Referral` (CAS PENDING→REWARDED, `stripeBalanceTransactionId` UNIQUE, `qualifyingInvoiceId`) | key `referral-reward:<referralId>` | `invoice.paid` (amount_paid > 0) | CAS = at most once; stranded rows audited hourly | `auditReferralGrants` | webhook only | **flag only**: refund/dispute/credit note of the qualifying invoice sets `reviewFlaggedAt`; a person decides | MEDIUM (no automatic clawback - by decision) | `services/referral.integrity.test.ts`, `referral.credit.test.ts` |
| Affiliate reward (dark) | ChairBack → affiliate shop | `min(list-price snapshot, referrer's live unit_amount)` | usd | `customers.createBalanceTransaction` | `AffiliateReward` (UNIQUE per referred shop) + `AffiliateCreditOperation` (UNIQUE per reward, claim token, attempt budget, ambiguity marker) | key `affiliate-reward:<rewardId>`; FOR UPDATE SKIP LOCKED claim | `invoice.paid` ×2 distinct invoices, 14-day hold | bounded backoff; ambiguous past 24h → ABANDONED, evidence-only resolution | admin credits desk; liability from the ledger | admin (isAdmin, IP allowlist optional) | reversal CAS on refund/dispute/credit note before APPLIED | LOW while dark | `engines/affiliateCredit.test.ts`, `affiliateCredit.race.test.ts` |
| Comp access | (no money) | n/a | n/a | none | `Shop.compAccess` | n/a | n/a | n/a | admin metrics | admin | toggle | LOW - **no audit row** (see findings) | `routes/financialAuthz.test.ts` |
| Chair checkout (cash/direct/card reader) | customer → shop, off-platform | barber's figure | usd | none | `Appointment.paidAmount/paidMethod/paidAt` (CAS on `paidAt`) | `paidAt` claim | n/a | n/a | revenue (`insightsWindow`) | manager | price edit (below) | LOW | `routes/chairCheckout.test.ts` |
| Price edit (PR #400, `POST /appointments/:id/price`) | (no money moves) | manager's figure, integer cents from the boundary; `collected` only after checkout, only the CHAIR column | usd | **none - never a Stripe call** | `Appointment.priceAtBooking` (+ `paidAmount`) and an append-only `AppointmentPriceChange` row in the same transaction | compare-and-set on the ticket read, on status, on `paidAt`; loser gets 409 `stale_price` | n/a | n/a | the ledger; the card-on-file fee reads the FIRST ledger entry (the agreed price) | manager (`requireManager`); BARBER 403; other shop 404 + tenant RLS | n/a (refunds stay on their own path; a ticket below what Stripe settled is refused) | LOW | `routes/appointmentPrice.test.ts` (15) |

Not present, and not built: transfers, payouts, `automatic_tax`, coupons of
our own (Stripe promotion codes are allowed on Checkout), mobile in-app
purchases (the app sells nothing; App Review notes say so).

## Invariants now enforced

- **Row first, Stripe second.** Every PaymentIntent (pay-ahead, terminal,
  card-on-file fee) has a `Payment` row with a `pending:` reservation id BEFORE
  the request leaves. A retry rebuilds the request from the row and reuses the
  key. (`billing/payments.ts`, `terminal.ts`, `cardOnFile.ts`)
- **Ambiguity is marked, never guessed.** A transport error (no Stripe `type`,
  no card answer) sets `Payment.ambiguousAt`; the card stays `charging`; nobody
  is told "declined". (`billing/stripeErrors.ts`)
- **The reconciler reads, repairs local state, never moves money.** Search by
  our metadata for a reservation; retrieve by id for a known intent; escalate
  contradictions; dry-run unless `PAYMENTS_RECONCILE_ENABLED=true`.
  (`billing/reconcile.ts`, job `payments-reconcile` every 15 min, leased)
- **One receipt per Stripe event id, on both endpoints.** Processed = duplicate
  (200, not re-applied); failed = re-applied on redelivery; in-flight = 503.
  Claimed only after signature verification. (`billing/stripeEvents.ts`,
  `StripeEventReceipt`)
- **Live and test never mix.** `event.livemode` must match the key's mode.
- **Subscription state never moves backwards in time.** `event.created` is
  compared against `Shop.subscriptionEventCreated` /
  `receptionistEventCreated` on every base / add-on write.
- **Every Stripe mutation carries a deterministic idempotency key**, enforced
  by a source guard (`financialInvariants.test.ts`), including the three that
  had none: `customers.create`, `subscriptions.update`, `checkout.sessions.create`.
- **Amounts are validated at the boundary**: integer cents in (0, $100,000],
  currency `usd`. Client-supplied amounts are never read on any charge path.
- **Refund totals are monotonic and compare-and-set**; cumulative refunds cannot
  exceed what was collected.
- **A raw Stripe error is never logged** from a money module or a webhook
  route - only `stripeErrorFacts` (type, code, request id, status). Source-
  guarded.
- **The legacy referral credit is keyed and recorded** (`referral-reward:<id>`,
  `stripeBalanceTransactionId` unique) and its qualifying invoice is remembered.
- **A by-hand price edit is one transaction with a memory.** `POST
  /appointments/:id/price` converts dollars to integer cents at the boundary
  (finite, non-negative, two decimals, under the ceiling, strict schema), then
  writes with a compare-and-set on the ticket it read, on the status, and on
  `paidAt` when the chair figure is included - and appends an immutable
  `AppointmentPriceChange` row in the same transaction. Two racing edits: one
  lands, one gets 409 `stale_price`. It never calls Stripe; it can never touch
  the `Payment` row; `paidMethod` is not editable through it; a ticket below
  what Stripe settled is refused. The chair figure is the one money figure
  ChairBack cannot verify (cash), and it may only be corrected after checkout
  wrote it. The card-on-file fee reads the FIRST ledger entry - the price the
  customer agreed to - so a raised ticket cannot raise a fee they consented to
  at the old one (`agreedPriceCents`). Revenue counts the chair figure once
  checked out, else the ticket (`insightsWindow.readChairEvents`).

## Findings

Severity is about money at risk today, not code taste.

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | HIGH | Subscription webhooks applied last-arrival-wins: an older `customer.subscription.updated` (active) redelivered after `deleted` (canceled) re-granted access | ordering guard on `event.created` + receipt dedupe |
| F2 | HIGH | No event-id dedupe on either endpoint for the billing and payment reducers (only the affiliate module had one); replay protection was per-handler | `StripeEventReceipt` claim/settle around every handler |
| F3 | HIGH | An off-session card-on-file charge that timed out was recorded as **declined**, and the barber told to collect at the chair - a second collection of a fee the customer may already have paid | ambiguity classification; reconciler resolves by Stripe's own state |
| F4 | MEDIUM | Pay-ahead / terminal intents were created at Stripe BEFORE the local row; a crash or lost reply left an orphan intent with no record, and a retry minted a second one | row-first reservation; same key on retry; reconciler adopts by metadata |
| F5 | MEDIUM | Legacy referral credit had no idempotency key and stored no transaction id; a refund/dispute/credit note of the qualifying invoice left the reward silently in place | keyed, recorded, invoice remembered; reversal FLAGS for review (no automatic clawback - a policy decision left to the owner) |
| F6 | MEDIUM | No live/test mode separation in code (endpoint secrets were the only wall) | `livemode` check, refused before any write |
| F7 | MEDIUM | Bad-signature path logged the full unverified payload (`logger.warn({ err })` on a `StripeSignatureVerificationError` carries header + body); money modules logged whole Stripe errors (card errors carry the PaymentIntent and its `client_secret`) | classification-only logging, source-guarded |
| F8 | MEDIUM | Refund total updated read-modify-write; two concurrent partial refunds computed from one total could both land locally (Stripe collapsed them by key) | CAS on the prior total |
| F9 | LOW | `customers.create`, `subscriptions.update` (proration invoice), `checkout.sessions.create` carried no idempotency key | keys added |
| F10 | LOW | Comping a shop (`POST /admin-portal/shops/:id/comp`) writes no audit row | **not fixed** - noted; admin identity is in the request log only |
| F11 | INFO | `Shop.platformFeeBps` is not writable through any route (DB-only); every shop is 0 | none needed |
| F12 | INFO | Express account creation (`ensureConnectAccount`) still exists but is unreachable for new shops (`/connect/onboard` answers 410 without an account); `charges_enabled`/`payouts_enabled` are read from existing accounts | left as is - no new Connect code was written |
| F13 | INFO | Money is stored as `Decimal(10,2)` on Appointment/Service and converted with `Math.round(x*100)` at the boundary; Payment/affiliate tables are integer cents | not converted (a storage migration of live rows is out of scope); boundaries validated |
| F14 | MEDIUM | (found while auditing PR #400) The card-on-file fee was computed from the CURRENT ticket, so a price raised by hand after the customer saved a card would raise the no-show fee they never consented to; the price edit itself overwrote the figure with no record and read-then-wrote without a compare-and-set | append-only `AppointmentPriceChange` ledger in the same transaction; CAS on ticket/status/`paidAt`; `agreedPriceCents` caps the fee basis at the first ledger entry (the agreed price); an unpriced-at-booking appointment agrees to nothing (fee 0) |

Withdrawn during the audit: "Payment has no RLS" - the live catalog shows RLS
enabled + forced with a `tenant_isolation` policy (the migration grep missed
it). Proven by `packages/db/src/rls.test.ts` and the receipt-table test.

## Dependency: PR #400 (price edit) and this PR

#400's head (`ff827a9`) was **not** an ancestor of this branch when the audit
was first opened - both forked from `a6c4177`. This branch was rebased onto
#400's head so the price-edit path is inside the audited tree, and the tests
in `routes/appointmentPrice.test.ts` and the F14 fix above are the result.
The tested tree hash is recorded in the PR. If #400 is squash-merged to main
with nothing else landing in between, main's tree equals #400's tree, and
rebasing this branch onto that main reproduces the same tree hash; if anything
else lands first, the tree differs by exactly those unrelated files and the
gates should be re-run.

## Webhook subscriptions (owner-verified 2026-09-03, screenshot)

`/webhooks/stripe` receives: `charge.refunded`, `charge.dispute.created`,
`checkout.session.completed`, `credit_note.created`,
`customer.subscription.{created,deleted,updated}`, `invoice.paid`,
`payment_intent.{canceled,payment_failed,processing,succeeded}`,
`setup_intent.succeeded`. Whether a second destination points at
`/webhooks/stripe-connect` (for `account.updated` /
`account.application.deauthorized`) is **not verified** from here.

## Kill switches (state at the end of the audit)

| Switch | Default | Effect when off |
|---|---|---|
| `AFFILIATE_PROGRAM_ENABLED` | false | every affiliate surface 404s |
| `AFFILIATE_PUBLIC_APPLICATIONS_ENABLED` | false | the application door is closed |
| `AFFILIATE_QUALIFICATION_ENABLED` | false | qualification worker dry-runs |
| `AFFILIATE_CREDIT_EXECUTION_ENABLED` | false | credit job dry-runs, no Stripe call |
| `PAYMENTS_RECONCILE_ENABLED` (new) | false | reconciler reads Stripe, writes nothing |
| `DRY_RUN` | true | no SMS leaves the building |
| `REWARDS_ROTATE_ALL_ENABLED` | false | the corpus rotation cannot start |

None were changed. All four affiliate flags are absent from Railway (owner-
confirmed), which parses as false.

## What is not proven here

- **Stripe amounts.** $34.99 / $74.99 / $40 live on Stripe Prices whose ids are
  env vars; this box holds no Stripe key, so the amounts, the absence of an
  annual price, and the account's default API version are unverified. The
  code's `PLANS` constants say 34.99 / 74.99 and are guarded to be exact cents.
- **Search API latency.** The reconciler's adopt-by-metadata relies on Stripe
  Search, which lags writes by up to a minute; the ten-minute grace window
  covers it, but only production traffic proves the timing.
- **Dispute won/lost.** No handler acts on `charge.dispute.closed`; a lost
  dispute on a customer payment leaves `Payment` unchanged (the shop, as
  merchant of record, absorbs it at Stripe). Flagging is subscription-side
  only.
- **Legacy referral clawback.** Deliberately a review flag, not a reversal -
  a half-used trial month and a consumed credit are policy, not arithmetic.
- **Test-mode Stripe.** The local key is a placeholder; every Stripe call in the
  tests is a fake. Idempotency-key REPLAY (Stripe returning the earlier
  response) is asserted by key equality, not by a live Stripe.
- **Comp audit trail** (F10) is unchanged.

## Gates

The gates and their real exit codes are recorded in the PR that carries this
document, against the exact tree hash they were run on - not here, so that
recording a result never changes the tree the result is about. The gate list:

- `pnpm --filter @chairback/api test` (the merge gate - CI runs Vercel builds only)
- `pnpm --filter @chairback/web test`, `@chairback/config test`, `@chairback/db test`
- typecheck for api, web (compare the error MULTISET against main - the
  dual-React `TransitionFunction` family is a known baseline), config, db, mobile
- `pnpm --filter @chairback/api build` (the Railway gate `tsc`s the tests too)
- `pnpm --filter @chairback/web build` (the Vercel gate)
- migrations: from scratch (`migrate reset` in the feature worktree), incremental
  (`migrate reset` from a worktree at the base branch, then `migrate deploy` from
  the feature worktree: exactly the new migrations pending), second deploy = no-op,
  and `migrate diff --from-migrations --to-schema-datamodel` for drift
- a regex secret scan over tracked files; `financialInvariants.test.ts`
- lint - there is no functioning lint tool in this workspace (`eslint` is not
  installed), which is reported, not hidden

🔴 `prisma migrate diff --shadow-database-url` RESETS the shadow database it is
given. Point it at a scratch database (`chairback_shadowcheck`), never at
`chairback_test`: pointing it at the test database wipes `_prisma_migrations` and
every table, and the next `migrate deploy` answers P3005.

The production API reported commit `a6c4177` at `/healthz` (read-only) when the
audit started. Nothing was deployed, merged or enabled, no Stripe setting was
changed, and no production money moved.

## Operating the reconciler

Turn on `PAYMENTS_RECONCILE_ENABLED=true` in Railway after watching a few
dry-run passes in the logs (`payments reconcile pass` with counts). It never
creates money movement; the worst it does is mark a reservation `failed` when
Stripe holds nothing for it after ten minutes. Escalations (`reconcile: …`
error lines + Sentry) name ids only and repeat every pass until a person
resolves the row - by design.
