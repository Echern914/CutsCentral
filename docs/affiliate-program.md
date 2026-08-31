# Affiliate Program

The NEW affiliate engine (this document), as distinct from the legacy referral
program (`services/referral.ts`, `Shop.referralCode`, the `Referral` table),
which keeps running untouched until the attribution phase freezes new legacy
attributions. Existing legacy referrals are honored at their historical terms
forever.

One engine, two eventual experiences: **Refer & Earn** for existing ChairBack
businesses, and an application-gated **Partner Program** for approved external
partners later. Version 1 is subscription-credit only — no cash, no Stripe
Connect payouts, no tax-document collection, no multi-level referrals.

## The business contract (locked)

Encoded as one versioned object in `packages/config/src/affiliateProgram.ts`
(`AFFILIATE_POLICY`, `AFFILIATE_POLICY_VERSION = 1`) — never scattered
constants:

- Attribution window **60 days**; locks the instant the referred Shop is
  created; an explicitly entered code beats a cookie before the lock; after
  the lock only a platform admin may correct it, within **7 days**, with a
  written reason and an audit event.
- Referred business receives its normal trial only (no extra discount in v1).
- Referrer earns **one month of their own current base subscription** (pro
  $34.99 / pro_ai $74.99 at today's prices — snapshotted as money+currency
  from the real Stripe subscription at qualification, never recomputed, never
  read from a constant). The $40 receptionist ADD-ON subscription, tax, SMS
  usage, fees and one-time purchases are always excluded.
- Qualification: **two successful, non-zero, base-subscription invoices**
  (distinct Stripe invoice ids — replays never count twice), then a **14-day
  hold**. Rewards expire **12 months** after becoming available.
- More than **12 qualified rewards in a rolling year** holds further rewards
  for admin review — held, never silently discarded.
- Refund/dispute before application reverses the pending reward; after
  application it creates an auditable negative ledger adjustment. The
  referrer's card is never charged.
- Suspension keeps all history; a suspended code earns no new attribution.
- One referred Shop belongs to exactly one affiliate; one qualification
  reward per referred Shop; credits are non-transferable, non-refundable,
  never cash. **No automatic SMS anywhere in this program.**

## Feature flags (all dark by default)

`packages/config/src/env.ts`, house `boolish` (accepts exactly
`true|false|1|0`; anything else kills boot — fail closed):

| Flag | Gates |
|---|---|
| `AFFILIATE_PROGRAM_ENABLED` | master: off ⇒ every affiliate surface 404s before auth, indistinguishable from unmounted |
| `AFFILIATE_PUBLIC_APPLICATIONS_ENABLED` | the application door only (status stays readable) |
| `AFFILIATE_QUALIFICATION_ENABLED` | qualification phase worker (declared; nothing reads it yet) |
| `AFFILIATE_CREDIT_EXECUTION_ENABLED` | credit-execution outbox (declared; nothing reads it yet) |

Deploying this phase's migration changes nothing user-visible: no UI, no
attribution capture, no qualification, no Stripe mutation, no email, no SMS.

## Phase 1 (this PR): applications, accounts, audit spine

**Tables** (migration `20260901000000_affiliate_program_foundation`) — all
three DEFAULT-DENY (REVOKE from `chairback_app`, RLS enabled + FORCED, zero
policies; owner-executed services only, keyed by the session's shop id):

- `AffiliateApplication` — the owner's request: promotion channels, audience,
  links, plan, FTC acknowledgement, versioned terms acceptance; decision as a
  FIXED classification + admin-only `internalNote`. The applicant-visible
  message is DERIVED from the classification
  (`AFFILIATE_DECISION_PUBLIC_COPY`, business-type-neutral) — admin free text
  never reaches an applicant. At most one PENDING per shop via a partial
  unique index (the double-submit guard; the service never
  pre-checks-then-inserts).
- `AffiliateAccount` — minted only by approval, one per shop ever
  (`shopId` unique). Public code = `randomToken(9)` → 12 base64url chars
  (72 bits): an identifier, not a credential; inert until the attribution
  phase. Suspension flips status + stamps why; nothing is ever deleted.
- `AffiliateAuditEvent` — append-only (BEFORE UPDATE trigger binds every role
  including the connection owner; DELETE deliberately stays possible —
  retention is a policy decision). No FKs: history outlives its subjects. Ids
  and fixed codes only; sanitizer = key allowlist, scalars only, ≤64 chars,
  personal-data heuristics with the cuid exemption. The `type` CHECK pins the
  FULL arc vocabulary now (attribution/reward/credit events included) so later
  phases never alter a constraint under live traffic.

**API** — owner: `GET /api/affiliate/status`,
`POST /api/affiliate/application` (owner role only, rate-limited,
double-submit-proof). Admin (under `/api/admin-portal/affiliate`, inheriting
session + `User.isAdmin` — 404 for every non-admin): pending queue, detail,
approve / reject / suspend / reactivate, every transition a CAS committing
atomically with its audit event.

## Destination schema (later phases — design, not migrated)

- **Attribution**: `AffiliateReferralAttribution` — `referredShopId @unique`
  (the lock), `codeUsed` snapshot, `capturedVia` (`explicit_code|cookie`),
  captured/locked/corrected instants + fixed correction reason. Signed,
  purpose-tagged, HttpOnly cookie (house HMAC pattern, `SESSION_SECRET`
  reuse is safe per the session module's purpose guard); all signup doors,
  including threading attribution through the Google/Apple OAuth `state`
  round-trip; atomic lock at the single `POST /api/shops` choke point;
  aggregated click counters (no raw IPs; HMAC any abuse signal with bounded
  retention). Freezes the legacy program.
- **Qualification + ledger**: `AffiliateQualifyingInvoice`
  (`stripeInvoiceId @unique` = replay-proof distinct-invoice counting inside
  the EXISTING `applyStripeEvent` — no competing webhook), base-subscription
  filter, two invoices + 14-day hold, `AffiliateReward` immutable ledger with
  money/currency/basis-plan snapshot, refund/dispute handlers (new event
  subscriptions, additive to the platform webhook), append-only reversals,
  rolling-year review flag, hold/expiry cron with its `job_lease` seed.
- **Credit execution**: `AffiliateCreditOperation` outbox — the EmailIntent
  shape verbatim (claim token, attempts, `firstProviderAttemptAt`,
  write-ahead `lastAttemptAmbiguous` set in the reserving statement, 24h
  provider window, fixed failure classifications). Stripe idempotency key
  `affiliate-reward:<rewardId>` — durable identity, never clocks. Reserve →
  commit → `customers.createBalanceTransaction` (negative amount) → store the
  returned transaction id. Stripe's customer balance is a single scalar: the
  app ledger is the source of truth, the balance only the application
  mechanism. Balance credits apply to the invoice total post-tax — tax is off
  today; enabling Stripe Tax later requires a separate tax review of this
  program.

## Standing cautions

- `invoice.paid` must be confirmed enabled on the live Stripe webhook
  endpoint before the qualification phase is switched on (standing owner
  item — the legacy program has the same dependency).
- Referral credits change invoice totals; any future tax enablement needs a
  tax review before this program's credits are live.
- The platform webhook has no event-id dedupe table; qualification counts
  distinct invoice ids instead, which is sufficient for this program.
