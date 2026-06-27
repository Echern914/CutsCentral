# ChairBack — Scale-Readiness Audit (2026-06-26)

> Question behind this: "How do we scale this to be the best, like Booksy?"
> Answer for the codebase: before features, fix the things that make the app **slow now** and **outage-prone the moment a real number of shops show up**. Booksy's moat isn't features — it's that it stays up under load. This is the list that gets you there.

Every finding below is verified against the source (file:line). Ranked by "will this hurt you, and when."

---

## ✅ Already resolved — the #1 risk is CLOSED

### 1. Production database connection pool — **already at `connection_limit=10`** (verified 2026-06-25)
The live Railway `DATABASE_URL` runs a real pool of 10. This was the top scale bottleneck and it's **done.** Verify via the **Railway dashboard**, not the local script — local `.env` uses the direct `5432` URL and can't grade the pool.

> ⚠️ **Doc-staleness lesson (this is the actual takeaway):** `DEPLOY.md` showed `connection_limit=1` until this pass — a stale copy of the original template. The first version of this audit wrongly flagged the pool as broken because a sub-agent trusted that doc over the live config. `DEPLOY.md:21` has now been corrected to `=10`. **Lesson: grade the running env (Railway), never a checked-in doc, when auditing prod config.**

For context on why this mattered: the API is one long-lived Railway process and *every* tenant query runs inside a transaction ([`tenant.ts:43`](../packages/db/src/tenant.ts#L43)), so a pool of 1 would serialize all concurrent requests. A boot-time check warns if it's ever set too low — [`index.ts:37-55`](../apps/api/src/index.ts#L37-L55).

---

## 🟠 P1 — Will cause outages / double-texts the moment you grow

### 2. SMS/push sends run **synchronously inside the HTTP request**, in an unbounded loop
**Evidence:** promo blast [`promotions.ts:345-394`](../apps/api/src/routes/promotions.ts#L345-L394), bulk nudge [`dashboard.ts:767-797`](../apps/api/src/routes/dashboard.ts#L767-L797), sweep [`nudge.ts:213-313`](../apps/api/src/engines/nudge.ts#L213-L313). Each loop iteration awaits a Twilio call (~100ms) one at a time.

**Why it matters:** A shop blasting 200 clients = ~20s+ of one request holding a worker. A shared long-code Twilio number is limited to ~1 msg/sec, so 50 sends already queues or 429s. Express times out mid-blast → some clients texted, some not, nudge rows stuck `PENDING`. At 100 shops hitting "blast" near 9am, the API stalls for everyone.

**Fix direction:** Move sends to a durable job queue (pg-boss is the lowest-friction here — it lives in your existing Postgres, no new infra). Enqueue in the request, return immediately, a worker drains at a safe rate.

### 3. No real job queue — all background work is `node-cron` in **one** process, hard-coded single-replica
**Evidence:** [`scheduler.ts`](../apps/api/src/scheduler.ts) — comment literally says *"SINGLE-REPLICA assumption — if the API ever scales out, wrap each job in a pg_advisory_lock or move to Railway cron."*

**Why it matters:** This is the trap. The obvious way to handle more load is "add a second Railway replica." The moment you do, you have **two schedulers** running the 10am nudge sweep with no coordination → **every client gets texted twice** (TCPA exposure, not just annoyance). So today you literally *cannot* scale horizontally without a code change first. That's the ceiling.

**Fix direction:** Same pg-boss queue solves this — one worker owns the schedule regardless of replica count. Cheaper interim: wrap each cron job in a `pg_advisory_lock` (the booking path already uses advisory locks, so the pattern exists in your codebase).

### 4. Daily SMS cap is bypassable and does a full-table count per send
**Evidence:** [`nudge.ts:159-171`](../apps/api/src/engines/nudge.ts#L159-L171), [`promotions.ts:328-331`](../apps/api/src/routes/promotions.ts#L328-L331), [`dashboard.ts:758-761`](../apps/api/src/routes/dashboard.ts#L758-L761). The cap is a `COUNT(*)` of today's nudges taken **once** at the start of a send action.

**Why it matters:** Two send actions running in parallel each read the same "sent so far" number, so the cap can be blown 2–10×. And the count scans the growing `Nudge` table on every send. Real money + compliance, not cosmetic.

**Fix direction:** Atomic counter (a per-shop-per-day row you `INCREMENT ... RETURNING`, or enforce in the queue worker which is single-threaded anyway).

### 5. No idempotency / dedup key on sends
**Evidence:** `Nudge` schema has no unique constraint on `(shopId, clientId, kind, day)` — [`schema.prisma` Nudge model](../packages/db/prisma/schema.prisma). Booking create has no idempotency token ([`booking.public.ts`](../apps/api/src/routes/booking.public.ts)).

**Why it matters:** A retried cron tick, a double-clicked "sweep now," or a redelivered webhook → duplicate texts and duplicate bookings. Couples with #3 (two replicas).

**Fix direction:** Unique constraint as a dedup guard + idempotency key on the booking POST.

---

## 🟡 P2 — Query amplification: works at 3 shops, drags at 100

The architecture has a sharp edge: **every `forShop(...).model.op()` opens its own transaction** ([`tenant.ts:39-52`](../packages/db/src/tenant.ts#L39-L52)). Convenient, but it means "5 reads for one request" = 5 transactions = 5 connection checkouts. Combined with P0 (#1), this is multiplicative.

### 6. Loops that issue a query (or a whole transaction) per row
- Bulk nudge: ~2 transactions × up to 200 clients per request — [`dashboard.ts:767-797`](../apps/api/src/routes/dashboard.ts#L767-L797)
- Push fan-out: 1–3 DB writes **per device**, serial, inside the per-client loop — [`push.ts:218-274`](../apps/api/src/messaging/push.ts#L218-L274)
- Per-appointment promotion + cadence: 2 transactions each — [`appointmentPromotion.ts:128-160`](../apps/api/src/engines/appointmentPromotion.ts#L128-L160), [`cadence.ts:11-44`](../apps/api/src/engines/cadence.ts#L11-L44)

**Fix direction:** Batch reads into a single `runWithShop` transaction; `Promise.all` (or a single bulk write) the push fan-out; move per-row work into the queue worker.

### 7. Unbounded `findMany` (no pagination) on tables that grow forever
- Client CSV export — [`dashboard.ts:1099-1101`](../apps/api/src/routes/dashboard.ts#L1099-L1101)
- Nudge history export with a join — [`dashboard.ts:1129-1132`](../apps/api/src/routes/dashboard.ts#L1129-L1132)

**Why it matters:** Fine at 50 clients, a memory spike at 10k. **Fix:** cursor-paginate or stream.

### 8. Slots/availability does ~7 sequential scoped queries per slot fetch
**Evidence:** [`slots.ts:115-265`](../apps/api/src/engines/slots.ts#L115-L265). Each booking-page load = 7 transactions. Booking volume is lower than the sweep, so this is P2 not P1 — but it's the customer-facing path, so latency here is felt directly. **Fix:** batch into one transaction.

---

## What I'd actually do, in order

1. ~~Flip the prod connection pool to 10~~ — **already done** (verified at the top). The #1 risk is closed.
2. **Next, the real top priority:** introduce **pg-boss** (queue in your existing Postgres). Move SMS/push sends + the cron schedule onto it. This single change resolves #2, #3, and most of #4 — and unlocks horizontal scaling (today you literally can't add a replica without double-texting).
3. **Same PR or next:** dedup constraint on `Nudge` + idempotency key on booking (#5).
4. **Then:** batch the per-row loops and paginate the exports (#6, #7, #8) as you touch those routes.

None of this is a rewrite. The tenant/RLS model is genuinely well-built and isolation is solid — the gaps are all "synchronous where it should be queued" and "one connection where it should be ten." That's a good place to be: the hard architecture is right, the scaling fixes are mechanical.

---
*Generated by Claude Code scale-readiness audit. All findings verified against source at the cited file:line.*
