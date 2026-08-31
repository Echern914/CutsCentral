# Affiliate Program

The NEW affiliate engine (this document), as distinct from the legacy referral
program (`services/referral.ts`, `Shop.referralCode`, the `Referral` table).

🔴 **The legacy program keeps running, untouched and authoritative.** It is the
only system that can qualify or pay anything, and it stays that way until a
later, separately reviewed cutover — never as a side effect of shipping a phase
here. Existing legacy referrals are honored at their historical terms forever.

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
| `AFFILIATE_QUALIFICATION_ENABLED` | the qualification consumer and the reward-hold sweep (read from phase 3; both inert while it is false) |
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
  aggregated click counters (no raw IPs). Shipped in phase 2 — see below for
  what was actually built, which reaches every OAuth door WITHOUT touching
  `state`, and which leaves the legacy program alone.
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
- The platform webhook's LEGACY handlers still have no event-id dedupe, by
  design: phase 3 added `StripeWebhookEvent` for the affiliate consumer only,
  so legacy billing keeps its exact existing replay behaviour.

---

# Phase 2: attribution (shadow mode)

Attribution runs end to end — link, claim, every signup door, the lock at shop
creation — and writes nothing in production, because every flag is false. The
legacy program is **untouched and authoritative**; see the coexistence rules
below.

## The attribution state machine

```
                    /join?ref=CODE            /join/enter  (cross-device)
                          |                        |
                    validate server-side ----------+
                          |
              ACTIVE affiliate?  --no--> neutral 200, no cookie, nothing recorded
                          |yes
                signed claim -> HttpOnly cookie on the WEB origin (60d)
                          |
        ( password | Google | Apple | mobile->web handoff )   <- claim untouched
                          |
                  POST /api/shops   (the ONE shop-creation boundary)
                          |
     plan BEFORE the tx:  forged/malformed -> no row at all (never was a claim)
                          |                 legacy will claim it -> REJECTED legacy_claimed
                          |                 expired  -> REJECTED claim_expired
                          |                 unknown/rotated code -> REJECTED unknown_code
                          |                 suspended -> REJECTED affiliate_suspended
                          |                 own link  -> REJECTED self_referral
                          |                 otherwise -> ATTRIBUTED
                          |
        INSIDE the shop tx: createMany(skipDuplicates) on referredShopId UNIQUE
                          |
                     terminal. Only a platform-admin correction (<=7 days,
                     written reason, append-only event) ever moves it again.
```

**Failure policy, stated explicitly.** Validation happens *before* the
transaction and can never fail it — any error is treated as "no claim", so a
barber never loses a shop to an affiliate problem. The single row is written
*inside* the transaction, so a committed shop always carries its attribution
outcome and a crash leaves neither. An ineligible affiliate produces a durable
`REJECTED` row rather than a silent drop.

## The OAuth trust boundary

**Nothing about attribution enters the OAuth channel.** The claim is an
HttpOnly cookie on the web origin; Google and Apple never receive it, and
nothing is added to `state`. The web server forwards its own cookies when it
calls `POST /api/shops`, which is how a Google- or Apple-created account still
gets attributed. Consequences, each covered by a test:

* The provider's `state`/CSRF validation is untouched and unweakened.
* No referral code — signed or otherwise — is placed in `state`.
* A referral parameter *returned by a provider* is read by nothing.
* A cancelled, replayed or wrong-state callback cannot consume or bind a claim,
  because only creating a shop binds anything, and that is guarded by a unique
  index.
* Google and Apple are tested separately; neither result is inferred from the
  other.

## Lock and transaction ordering

1. Resolve and validate the claim (`runAsOwner` reads, outside any transaction).
2. Open the shop transaction: Shop → first Reward → owner ShopMember → SMS
   attestation → **attribution insert**.
3. Commit.
4. *After* commit, unchanged: the legacy referral link and its trial extension.

## Legacy coexistence, and the later cutover

**PR 2 changes nothing about the legacy program.** It is not frozen,
redirected, or partially replaced, and it remains the only system that can
qualify or pay anything. One rule makes double-claiming impossible while both
exist:

> 🔴 **Legacy wins.** If the shop being created arrived with a legacy referral
> code that resolves to a real referrer, the new system records
> `REJECTED / legacy_claimed` and never touches that shop. Enforced in
> `planAttribution`, tested directly.

### Inventory (aggregate only, no PII)

⚠️ **These numbers are from the DEV database, not production.** The credentials
available on this machine reach the dev Supabase (100 migrations, no affiliate
tables); production is a separate instance that could not be queried from here.
Dev: 1 legacy referral, `REWARDED`, `trial_extension`, created 2026-08-03; 0
ambiguous rows; 0 shops with multiple claims; 7 shops in total.

**Structural facts, true in every environment** (read from the migration, not
the data): `Referral_referredShopId_key` is **UNIQUE**, so a referred shop can
hold **at most one** legacy claim; `rewardKind` / `rewardAmountCents` are
written only when a reward was actually granted, so their presence is the
credit evidence; a `REWARDED` row with a NULL `rewardKind` is the one ambiguous
shape (a grant that committed and then stranded), which is exactly what the
hourly `referral-grant-audit` job already reports.

**Run this against production before the cutover** (read-only, aggregate):

```sql
SELECT status, count(*) FROM "Referral" GROUP BY status;
SELECT COALESCE("rewardKind", '(none)') AS kind, count(*) FROM "Referral" GROUP BY 1;
SELECT min("createdAt"), max("createdAt") FROM "Referral";
SELECT count(*) FROM "Referral" WHERE status = 'REWARDED' AND "rewardKind" IS NULL;
SELECT count(*) FROM "Referral" WHERE status = 'PENDING'
   AND ("rewardedAt" IS NOT NULL OR "rewardKind" IS NOT NULL);
SELECT count(*) FROM (SELECT "referredShopId" FROM "Referral"
                       GROUP BY 1 HAVING count(*) > 1) d;
```

### Cutover design (documented now, executed later)

* **Canonical identity:** the **referred shop id**. It is unique in both
  systems (`Referral.referredShopId` and
  `AffiliateReferralAttribution.referredShopId`), which makes "claimed by
  exactly one system" checkable with a single join.
* **Durable mapping:** the import adds `legacyReferralId` (unique, nullable)
  to the attribution row plus `importedAt`, so every migrated record points
  back at the legacy row it came from and a re-run is a no-op by unique
  violation.
* **Unique constraints doing the work:** `referredShopId` UNIQUE (one
  attribution per shop — already live) and `legacyReferralId` UNIQUE (one
  attribution per legacy row — added at import).
* **Lock order at import:** legacy row → attribution row → reward ledger,
  always in that direction, one referred shop per transaction, so two importers
  can neither deadlock nor leave a half-migrated shop.
* **Import mapping:** `PENDING` legacy → attribution `ATTRIBUTED`, no reward;
  `REWARDED` legacy → attribution `ATTRIBUTED` **plus a reward created in a
  terminal already-settled state** carrying the legacy `rewardKind` and
  `rewardAmountCents`; `VOID` → attribution `REJECTED / self_referral`.
* **Previously credited can never be credited again:** an imported reward is
  born terminal, the qualification engine only ever advances rewards from
  `PENDING_HOLD`, and the reward table's `referredShopId` is unique.
* **Pending legacy referrals** either finish under legacy rules before the
  cutover or are imported exactly once after phase 3 exists — never both,
  because the import runs only after legacy attribution is switched off, and
  the switch and the import are one operation with one owner.
* **No dual write** begins without deterministic tests and a reconciliation
  pair that must return zero rows for "claimed in both systems" and zero for
  "creditable twice".
* **Rollback:** the import is additive and idempotent, so rolling back is
  re-enabling legacy attribution and deleting attribution rows carrying
  `importedAt` — which leaves legacy exactly as it was. The same reconciliation
  pair verifies either direction.
* **Boundary:** the cutover is a **separately reviewed operation**. It is not
  part of PR 2, and PR 2 is deployable and revertible without it.

## Flags (all still false)

`AFFILIATE_PROGRAM_ENABLED` gates every attribution surface: the `/join` route,
`/join/enter`, the public claim endpoint, and the lock inside shop creation.
While it is false `planAttribution` returns before it even reads a cookie, so a
claim minted during a brief enablement cannot bind afterwards.

---

# Phase 3: qualification, and the two invariants phase 2 left open

## The same-owner shop-creation lock

`POST /api/shops` enforced "one shop per owner" with a read followed by a
write, which is not a rule: two simultaneous requests from the same owner both
saw "no shop" and both created one. Everything now happens in **one
transaction, in one order**:

```
1. pg_advisory_xact_lock(hashtext("shopcreate:<ownerId>"))
2. does this owner already have a shop?      -> 409 shop_exists, naming it
3. create Shop (+ first reward, owner seat, SMS attestation)
4. validate the affiliate claim
5. write the attribution outcome, or its durable rejection
6. commit  (which is also what releases the lock)
```

A transaction-scoped **advisory lock**, not a unique index on `Shop.ownerId`:
multi-location ownership is a live possibility and a unique index would
foreclose it, whereas the lock enforces today's contract without writing it
into the schema. `pg_advisory_xact_lock(hashtext(...))` is the house primitive
(`engines/bookingWrite.ts`, `engines/walkInQueue.ts`, `services/rewardsRecovery.ts`),
it is held by the database rather than the process, so it holds across API
replicas, and it is released by commit or rollback — never leaked.

Because claim validation moved inside the transaction, a genuine **database
fault** while resolving it now rolls the shop back too. That is the honest
outcome — nothing committed, the caller retries — and it is a different thing
from "this affiliate is not eligible", which is still recorded as a durable
rejection and still never costs anyone their shop.

**Lock order, everywhere that participates:** `shopcreate:<ownerId>` →
`Shop` → `AffiliateReferralAttribution`. The legacy path takes `Referral` →
`AffiliateReferralAttribution` and never acquires the owner lock, so no cycle
exists between them.

## The cross-ledger boundary

Phase 2 checked one direction only: at shop creation, look for an existing
legacy claim. That cannot stop the other order — and the other order is the
one that actually happens, because `linkReferralOnShopCreate` inserts its
`Referral` *after* the shop transaction has already committed an attribution.

The invariant now lives in the database, on the **legacy** table:

```sql
CREATE TRIGGER affiliate_legacy_supersedes_ins
  AFTER INSERT ON "Referral"
  FOR EACH ROW EXECUTE FUNCTION affiliate_legacy_supersedes();
```

Inserting a legacy `Referral` atomically supersedes any live attribution for
the same referred shop — `state -> REJECTED`, `rejectionReason ->
legacy_claimed`, `legacyReferralId -> the legacy row's id` — and writes an
`attribution.superseded_by_legacy` audit event, all inside the legacy
transaction. Properties, each pinned by a test:

* An existing legacy claim still makes the new attribution `legacy_claimed`
  (the phase-2 check, unchanged).
* A legacy claim arriving **after** a new attribution supersedes it atomically.
* If the legacy transaction rolls back, **so does the supersession**.
* The legacy insert itself is never blocked, altered or failed: the function
  cannot raise, and it is `SECURITY DEFINER` precisely so that a caller without
  rights on the default-deny attribution table still succeeds.
* An already-rejected attribution is left exactly as it is.
* `legacyReferralId` is UNIQUE — the durable reconciliation key the cutover
  imports against.
* No code, no personal data and no free text enters the audit row: the trigger
  writes a fixed two-key JSON object.
* Tenant sessions can neither read the attribution table nor reach the
  transition.

**What changed for legacy:** no legacy *file* changed — `services/referral.ts`
and `billing/stripe.ts` are untouched — but the legacy *table* gained a
trigger. In production that trigger can only ever act on new-system rows,
which cannot exist while the program is dark, so its effect on the live
program today is nil.

## Qualification

`applyAffiliateStripeEvent` runs **after** `applyStripeEvent` and
`applyPaymentEvent` in the same webhook, has its own event dedupe rather than
gating the shared handlers, and never throws — so legacy billing and the legacy
referral grant keep their exact existing semantics, and an affiliate problem
cannot cost Stripe a delivery the billing side already handled.

```
invoice.paid ──> already-seen event id?           -> stop   (StripeWebhookEvent, UNIQUE)
             ──> base-subscription cents > 0?     -> else stop (tax/add-on/one-time excluded)
             ──> customer -> Shop -> ATTRIBUTED attribution? -> else stop
             ──> record AffiliateQualifyingInvoice (stripeInvoiceId UNIQUE)
             ──> distinct qualifying invoices >= 2 ?
                        └─> create ONE AffiliateReward (referredShopId UNIQUE)
                            PENDING + holdEndsAt = now + 14d
                            REVIEW_REQUIRED if: affiliate suspended,
                                                referrer on no paid plan,
                                                or > 12 qualified in a rolling year
refund / dispute / credit note ──> reward PENDING|AVAILABLE|REVIEW_REQUIRED -> REVERSED
hourly `affiliate-reward-hold` ──> PENDING past its hold -> AVAILABLE (+12-month expiry)
```

**Two unique indexes carry the whole thing.** The *event* id makes a
redelivery a no-op; the *invoice* id makes qualification count distinct
invoices rather than deliveries — which matters because Stripe emits more than
one event about the same invoice, and out of order. The reward's
`referredShopId` unique index means two simultaneous qualifying invoices
produce exactly one reward, with the loser a `skipDuplicates` no-op rather than
an exception that would abort the transaction.

**No Stripe call happens anywhere in this phase.** The money snapshot comes
from the referrer's own plan in `PLANS`, recorded as `amountCents` +
`currency` + `basisPlan` and never recomputed. `RESERVED` and `APPLIED` belong
to the credit-execution phase; a reversal here is a status transition and an
audit event, never a card charge.

**Open item carried forward:** the snapshot is the plan's list price. A
referrer on a Stripe-discounted subscription would be credited more than they
pay. The credit-execution phase must reconcile against the real subscription
before applying anything.

## Before qualification can ever be switched on

`invoice.paid` must be subscribed on the LIVE Stripe webhook endpoint. It could
not be verified from this machine (no live Stripe credentials here), and this
phase deliberately does not check or change it. To confirm:

1. Stripe Dashboard → **Developers → Webhooks** (make sure the account is in
   **live** mode, not test).
2. Open the endpoint pointing at `https://api.getchairback.com/webhooks/stripe`.
3. Under **Events to send**, confirm `invoice.paid` is listed. Add it with
   **Update details → Select events** if it is not.
4. For reversals to work, also subscribe `charge.refunded`,
   `charge.dispute.created` and `credit_note.created`.
5. Nothing needs redeploying afterwards — the handlers already exist and stay
   dark behind the flags.

The same dependency has always applied to the **legacy** program: if
`invoice.paid` is not subscribed, legacy referrers have never been paid either.
