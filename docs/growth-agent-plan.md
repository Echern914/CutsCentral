# ChairBack — "Growth Agent": Lapsed-Client Win-Back (DESIGN ONLY)

> Written 2026-06-29. **Design doc, not built.** Grounded in a real code audit (Explore agent read `eligibility.ts`, `scheduler.ts`, `nudge.ts`, `loyaltyNotify.ts`, `quietHours.ts`, `schema.prisma`), not assumptions. Motivated by GlossGenius's "Growth Agent / Growth Analyst" — see [competitive-teardown.md](./competitive-teardown.md). This is the one category where GlossGenius is genuinely ahead and ChairBack has nothing.

---

## What it is (one sentence)

A per-shop background job that finds clients who are **overdue by their own cadence** and sends one consent-gated, quiet-hours-respecting "we miss you / time for a fresh cut" SMS (push-first where possible), then attributes any resulting rebooking — so the shop recovers revenue from clients who silently lapsed, automatically.

This is the small, honest, *shippable* version of GlossGenius's Growth Agent: not a chatbot, not an analytics oracle — a **proactive win-back nudge** that turns data ChairBack already has into bookings.

## Why this, and why NOT now

**Why it's the right feature:** ChairBack is already sitting on the entire substrate — booking history, computed cadence, consent state, loyalty, push, an SMS send gate. GlossGenius packages "proactive AI that finds you revenue" as the headline; we have the data to ship a real, narrow version of it. It's a catch-up item that plays to our existing infrastructure.

**Why NOT build it this session (the gating reality):**
1. **`DRY_RUN` is still `true`** and stays that way until the Twilio 10DLC Campaign clears review. A win-back job that mass-texts lapsed clients literally cannot send until then — it would sit dark behind the Noop provider.
2. **The scheduler is hard single-replica.** `apps/api/src/scheduler.ts` documents (and enforces by convention) that the API must run on exactly one replica while `ENABLE_SCHEDULER=true`; every replica fires every cron tick. A win-back blast is the *worst* job to run under that constraint — a second replica double-texts every lapsed client. This is the known scale blocker (node-cron, no job queue) from [positioning-one-pager.md](./positioning-one-pager.md).

So: capture the design now while the audit is fresh; build it on a job queue once 10DLC is live. Nothing here needs redoing later.

---

## What already exists (REUSE — do not rebuild)

The audit confirmed the win-back job is mostly assembly of existing parts:

| Capability | Where it lives | How win-back reuses it |
|---|---|---|
| **Lapsed detection** | `Client.lastVisitAt`, `Client.medianIntervalDays`, `Client.nextExpectedAt`; index `@@index([shopId, lastVisitAt])` | Query: `archivedAt IS NULL AND medianIntervalDays IS NOT NULL AND lastVisitAt IS NOT NULL AND (now − lastVisitAt) > medianIntervalDays + buffer`. The data and index already exist. |
| **Send eligibility gate** | `engines/eligibility.ts` → `isNudgeEligible()` (R1–R7) | Reuse directly. R5 `optedOut=false`, R6 E.164 phone, R7 `smsConsentAt != null` (TCPA) are exactly the consent rails win-back needs. |
| **Quiet hours** | `engines/quietHours.ts` → `inQuietHours(shop.timezone)` (8am–9pm local) | Reuse directly — same TCPA safe-harbor gate the nudge/loyalty jobs use. |
| **DRY_RUN gating** | `messaging/twilio.ts` `getMessageProvider()` returns `NoopMessageProvider` when `env.DRY_RUN=true` | Win-back respects it automatically — no extra wiring. Pass `opts.dryRun = env.DRY_RUN`. |
| **Per-shop opt-in toggle** | `Shop.loyaltyTextsEnabled` (boolean, default `false`) | Mirror the pattern with a new `winbackTextsEnabled` (see gaps). Off by default. |
| **Write-ahead SMS ledger** | `Nudge` model (`kind`, `status` PENDING→SENT/FAILED, `channel`) | Create `Nudge` rows with `kind="winback"` — crash-safe, attributable, and (like loyalty) **excluded from `dailySendCap`** since it's not a generic blast. |
| **Push-first / SMS-fallback** | `loyaltyNotify.ts` pattern (try free Web Push, fall back to SMS) | Same pattern: free push to installed devices first, SMS only if no push. |
| **Billing gate** | `stripe.ts` → `hasActiveAccess(shop, {now})` | Reuse so win-back doesn't send for shops on expired trials. |
| **Attribution** | `Nudge.resultedInBookingAt` / `resultedVisitId` + `linkBookingsToNudges` cron | Extend attribution to `kind="winback"` so we can report recovered revenue. |

## What's MISSING (the actual build)

1. **Job queue (the real blocker).** node-cron is in-process + single-replica. Win-back is a fan-out blast — the highest-risk job to run without cross-replica coordination. **Prereq:** the pg-boss-on-existing-Postgres job queue already identified as the scale fix. Until then, win-back can only run pinned to the single scheduler replica, same as today's jobs — acceptable for a soft launch, not for scale-out.
2. **`Shop.winbackTextsEnabled`** — new boolean column (default `false`) + settings UI toggle + a `skipReason()` check. Opt-in per shop, exactly like `loyaltyTextsEnabled`.
3. **Re-nag suppression (cohort-level).** `isNudgeEligible` R4 already suppresses per-client for 21 days, but win-back needs cohort awareness so we don't re-blast the same lapsed group every run. Add **one** of:
   - `Shop.lastWinbackRunAt` (DateTime?) → only run a shop's sweep if `> N days` since last, **or**
   - query "no `kind='winback'` Nudge for this client in the last N days" (no new column, slightly heavier query).
   Recommend the per-client query (Option B) — it's more precise and avoids penalizing a whole shop's cohort for one early run.
4. **Win-back copy/template** — a `kind="winback"` SMS body (per-shop override like the nudge template). Distinct from the cadence-nudge copy: warmer, "it's been a while," optional incentive.
5. **Push payload** — a `buildWinbackPush` variant of `buildNudgePush` with win-back CTA.
6. **Reporting** — a "win-back: clients re-engaged / revenue recovered" widget. Schema supports it via attribution; no UI exists. This is what makes it *feel* like GlossGenius's "found you $X" — surface the recovered dollars.

---

## MVP cut vs. full

**MVP (smallest thing that recovers revenue):**
- New cron `runWinbackSweep` in `scheduler.ts` (daily, off-peak), pinned to the single scheduler replica.
- Per-shop `winbackTextsEnabled` (default off).
- Reuse `isNudgeEligible` + `inQuietHours` + `getMessageProvider` (DRY_RUN) + `hasActiveAccess` unchanged.
- `Nudge` rows `kind="winback"`; per-client 90-day re-nag suppression via Nudge query.
- Push-first, SMS-fallback. One static per-shop template.
- **Ships dark behind `DRY_RUN` until 10DLC clears**, then flip per willing shop.

**Full (the "Growth Agent" experience):**
- Job queue (pg-boss) so it's safe under multiple replicas.
- Attribution extended to `kind="winback"` + a recovered-revenue dashboard widget ("ChairBack won back N clients = $X this month").
- Smarter targeting: segment by value (loyalty tier / lifetime spend), optional incentive in the message, A/B copy.
- Eventually: an LLM-drafted, brand-voiced message (this is the only part that's actually "AI" — and it's the *last*, least-important piece; the revenue is in the targeting + the send, not the copy).

## Explicitly NOT in scope

- A conversational AI / chatbot. GlossGenius's Growth *Analyst* answers ad-hoc questions; that's a much bigger build with far less ROI than the win-back send. Skip it.
- Reception (inbound call/text answering). That's GlossGenius's *coming-soon* Reception Agent — they haven't shipped it either; don't chase it before the win-back send exists.

---

## Launch checklist (when 10DLC is live)

1. Land pg-boss job queue (closes the single-replica double-text risk for *all* jobs, not just this one).
2. Migration: `Shop.winbackTextsEnabled` (default false).
3. `runWinbackSweep` engine reusing the gates above; per-client 90-day suppression.
4. Settings toggle + one default template.
5. ~~Extend `linkBookingsToNudges` attribution to `kind="winback"`.~~ ✅ DONE — attribution is now kind-aware (win-back uses a 14-day window vs the nudge's 7), with tests.
6. Enable for 1–2 friendly shops with `DRY_RUN=false`, watch the Nudge ledger, then widen.

---
*Design grounded in a verified 2026-06-29 code audit. Every "reuse" item names a real existing function/file; every "missing" item is a genuine gap. Build order is gated on 10DLC approval + the pg-boss job queue — both already on the roadmap.*
