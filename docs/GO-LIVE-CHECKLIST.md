# ChairBack — Go-Live Checklist (win-back + lease + optional booking)

> For deploying the work merged into `main` (PRs #41–#44). The win-back + lease + optional-booking arc went live on getchairback.com 2026-06-29.

---

## ✅ Migrations now run AUTOMATICALLY on every deploy

`apps/api/railway.json` has a `preDeployCommand`:

```json
"deploy": {
  "preDeployCommand": "pnpm --filter @chairback/db migrate:deploy",
  "startCommand": "pnpm --filter @chairback/api start"
}
```

So on every Railway deploy, pending migrations apply **before** the API starts. You do **not** hand-run migrations anymore. Just merge to `main`, let Railway deploy, and watch the logs for `All migrations have been successfully applied.` (idempotent — no-ops when nothing is pending).

**Never `prisma db push` against prod** — it wiped prod once. `migrate deploy` only.

### ⚠️ Hard-won lesson: the Supabase + Railway connection gotcha (2026-06-29)

Migrations use `DIRECT_URL` (port 5432). Getting them to run on Railway took four wrong turns — capture so it never repeats:

1. **Don't use a one-off Start Command swap to run migrations.** It kept getting reverted mid-run and shipped code ahead of its schema → `column Shop.winbackTextsEnabled does not exist` 500s. The `preDeployCommand` above is the right mechanism.
2. **`DIRECT_URL` must NOT be the direct host** `db.<ref>.supabase.co:5432` — it's IPv6-only and **Railway (IPv4) can't reach it** → `P1001: Can't reach database server`.
3. **Use the Supabase Session Pooler** for `DIRECT_URL`: `aws-1-<region>.pooler.supabase.com:5432`. It's IPv4 AND migration-capable (the *transaction* pooler on 6543 — used by `DATABASE_URL` — is NOT migration-capable). Get it from Supabase → Connect → **Session pooler**.
4. **Username must include the project ref** for any pooler: `postgres.<ref>` (e.g. `postgres.czqjnhwxcubnskyfamvb`), not bare `postgres` → else `P1000: Authentication failed`.
5. **Remove the `[ ]` placeholder brackets** around the password, and **URL-encode special chars** (`@` → `%40`, etc.) → else `P1000`. Easiest: copy the full string Supabase generates with the password filled in.

So the working prod env (Railway `@chairback/api` Variables):
- `DATABASE_URL` = transaction pooler (port 6543) — the live app, **leave alone**
- `DIRECT_URL` = **session pooler** (port 5432), user `postgres.<ref>`, password bracket-free + encoded

The 4 migrations from this arc (`job_lease`, `winback_texts`, `winback_lease_seed`, `booking_url_optional`) are **already applied to prod.** ✅

---

## Step 1 — Deploy the code

Push/trigger the Railway (API) + Vercel (web) deploys from `main`. Order doesn't matter once Step 0 is done.

- **Railway (API):** redeploy from `main`. Watch the boot logs for `scheduler started`.
- **Vercel (web):** auto-deploys on the `main` push, or trigger manually.

---

## Step 2 — Verify nothing is broken (everything still DARK)

At this point **nothing texts** — `DRY_RUN` defaults to `true` and `winbackTextsEnabled` is off per shop. So this step is purely "did the deploy land cleanly":

- [ ] **Dashboard loads** (this is the migration smoke test — if `job_lease`/`winback_texts` weren't applied, `/api/dashboard/stats` 500s).
- [ ] **Onboarding works with NO booking link** — start a signup, leave the booking field blank, confirm the shop creates.
- [ ] **"Preview win-back" button** on the dashboard runs and returns a list (or "no lapsed clients") — proves the win-back engine + lease wiring boot without error. Still sends nothing.
- [ ] **Railway logs**: no errors mentioning `job_lease`, `winback`, or `bookingUrl`.

If all green, the deploy is safe and live. The remaining steps are about *turning win-back on*, which is gated externally.

---

## Step 3 — Single-replica check (scheduler)

The DB-lease (#41) makes the scheduler **safe** on >1 replica, but verify the lease is actually doing its job before you scale:

- [ ] Confirm `ENABLE_SCHEDULER=true` on exactly the API service that should run jobs.
- [ ] In Railway logs, confirm jobs fire once per tick (look for `lease acquired` / the job-complete lines, not duplicates).
- [ ] You can NOW safely run >1 API replica if you want — the lease prevents double-texting. (Before #41 this was unsafe.)

---

## Step 4 — Turn win-back ON (gated on Twilio 10DLC)

**Do NOT do this until the Twilio 10DLC Campaign is APPROVED.** Until then, real marketing texts can't legally go out, and `DRY_RUN` must stay `true`.

Once 10DLC is approved:

1. [ ] **10DLC Campaign = approved** (check the Twilio console).
2. [ ] Flip `DRY_RUN=false` in Railway. (This is the master switch for ALL real sends — nudges, win-back, loyalty.)
3. [ ] Enable win-back **per shop, starting with ONE friendly shop**: set `winbackTextsEnabled=true` on that shop (DB or settings UI).
4. [ ] Use **"Preview win-back"** on that shop to see exactly who the 11:00 sweep will text. Sanity-check the list.
5. [ ] Wait for (or trigger) the sweep. Watch the `Nudge` rows (`kind="winback"`, `status` PENDING→SENT) + Railway logs.
6. [ ] Confirm the gold **"Win-back — N clients re-engaged · $X recovered"** card populates once a texted client rebooks.
7. [ ] Widen to more shops once the first one looks good.

---

## Step 5 — Non-code housekeeping (do anytime)

- [ ] **Google OAuth name:** Google Cloud Console → APIs & Services → **OAuth consent screen** → change **App name** from `CutsCentral` to `ChairBack`. (Fixes the "CutsCentral wants to access your Google Account" screen. ~2 min, no deploy.)
- [ ] (Optional) Add a booking link to test shops, or point them at native ChairBack booking, so their public page shows a Book CTA.

---

## Rollback notes

- All 4 migrations are **additive** (new table, new nullable columns, drop-NOT-NULL) — safe and reversible in practice. The code tolerates the columns being absent only if it's the OLD code, so roll back **code and schema together** if needed.
- If anything texts that shouldn't: flip `DRY_RUN=true` immediately — it's the global kill switch.

---
*Generated 2026-06-29. Migrations + flag defaults verified against the repo. The order is load-bearing: migrate → deploy → verify dark → (10DLC) → flip flags.*
