# ChairBack — Operations & Go-Live Dashboard

**This is the one page to open when you want to know: is prod healthy, are we ready to bring
customers on, and what's left that only I can do.**

For the *live* half of that question, don't read — run:

```bash
node scripts/status.mjs
```

It probes prod (web, API, public booking), the nightly backup, open PRs/issues, and whether
your local `main` is current, then prints a green/yellow/red summary.

`status.mjs` can only see prod from the *outside*. For the inside — which integrations are
actually configured on the running API — open **/admin → Launch readiness** (or
`GET /api/admin-portal/preflight`). It lists every optional-env seam as blocker / warning /
info with the env var that fixes each. Read it before handing any shop the keys: a missing env
var never crashes anything, it just makes the feature silently do nothing, and `DRY_RUN`
**defaults to true** — a box where nobody set it records "sent" and texts nobody.

Everything below is the part neither can check: human tasks, judgment calls, and where things live.

> Last full human review: **2026-07-22**. Update the date + boxes when you work an item.
> (The live-health facts here are just the last snapshot — trust `status.mjs` over this prose.)

---

## 🚦 Go-live verdict

**The software is ready to onboard customers.** Everything remaining is a human task, not code.
Scale has been audited well past 50 shops (see [scale-readiness-audit](scale-readiness-audit.md)).

---

## ✅ Verified working (re-run `status.mjs` to confirm it's still true)

- Prod web + API up; public booking live (real open slots for a real shop).
- Nightly off-site backup to Cloudflare R2 — the cron itself is proven green.
- All feature gates ON in prod: billing, Premium AI, SMS, AI receptionist.
- Attribution live: `?ref=code` on a landing page is captured and stored on signup
  (affiliate foundation — see the affiliates note below).
- Tracking pixels (Meta / PostHog) built but **dormant** until you set their env keys.
- App Store build 32 approved.

---

## 🔴 Before / at first customers — ONLY YOU CAN DO THESE

Ordered. Check the box when done; update "Last full human review" above.

- [ ] **1. Rotate the prod DB password** — it was exposed in a debug chat. Supabase → prod →
      Settings → Database → Reset (pick a password with NO special chars to avoid the `%40` dance).
      Then update the `PROD_DIRECT_URL` GitHub Actions secret **and** local `.env`.
- [ ] **2. Test one backup restore** — restore the latest R2 dump into a *throwaway* Supabase
      project (never over prod). Steps in [BACKUP.md](BACKUP.md). An untested backup isn't proven.
- [ ] **3. Live receptionist test** — from a phone that is NOT chernCuts, text **+1 551 377 6480**
      and complete a booking. The chain is tested in code but never walked end-to-end live.
- [ ] **4. Live booking test** — book a real appointment on getchairback.com/book/cherncuts from a
      phone. (The API side is health-checked by `status.mjs`; this is the human tap-through.)
- [ ] **5. Twilio: raise the account number-purchase limit** — new accounts are capped at a few
      numbers regardless of campaign capacity; every Premium-AI shop buys one. This is the *closest*
      scaling wall and Twilio support takes days. Do it before marketing hard.
- [ ] **6. Twilio: turn on billing auto-recharge** — a purchase that fails on balance looks like a
      generic provisioning error.
- [ ] **7. Watch the first real Premium-AI purchase** end-to-end: checkout → tier flips → number
      auto-provisions → receptionist answers on it. Never run with real money yet.
- [ ] **8. Lawyer pass** on Terms (§6 AI/receptionist liability) + the `/accessibility` statement.
- [ ] **9. Fix Google OAuth name** — the consent screen still says "CutsCentral". Google Cloud
      Console → OAuth consent screen → App name → "ChairBack". ~2 min, no deploy.

---

## ⚠️ Before you turn ON paid ads (Meta Pixel) — ORDER IS LOAD-BEARING

The privacy policy currently says *"we do not use third-party tracking pixels."* Setting the pixel
env var makes that false the same minute. So:

1. [ ] Amend `apps/web/src/app/privacy/page.tsx` — remove the "no pixels" line, add Meta + PostHog
       to the subprocessor list, add cross-context-advertising disclosure (CCPA). Fold into the lawyer pass.
2. [ ] **Also missing from the subprocessor list today:** Cloudflare (R2 backups), Stripe, Resend.
       Add all three. (Legal task, independent of pixels.)
3. [ ] Deploy the privacy update.
4. [ ] *Then* set `NEXT_PUBLIC_META_PIXEL_ID` (and/or `NEXT_PUBLIC_POSTHOG_KEY`) on the Vercel **web**
       project. `status.mjs` will flip the "Tracking pixels" line to a reminder once they go live.

PostHog (product analytics, no ad-targeting) is a much smaller disclosure lift if you want it sooner.

---

## 🟢 Affiliates — ready NOW

You can hand an affiliate a link like `getchairback.com/?ref=drick` today. Their signups are
recorded on `User.referralCode` (indexed). There is **no payout dashboard yet** — counting signups
per code is currently a DB query. Google-OAuth signups don't capture attribution yet (only
email/password); noted as a known gap, not a bug.

---

## 🧰 Nice-to-have code work (post-launch, not blockers)

- [ ] **CI: run the API test suite on PRs.** Highest priority. Today PR checks are Vercel-build-only,
      so red API tests can land on `main` unnoticed (has happened once). No GitHub Action exists yet.
- [ ] Flaky test: `booking.public.test.ts` idempotency assert counts globally → fails under parallel
      runs (passes 19/19 alone). Scope the assertion to its own shop.
- [ ] `findOrCreateConversation` has no `@@unique([shopId, phone])` — simultaneous Twilio deliveries
      can create 2 conversations. A unique constraint is the fix.
- [ ] No ESLint config in `apps/web` → the jsx-a11y accessibility conventions aren't enforced.
- [ ] LineChart tooltips are mouse-only (no keyboard access to per-point values).

---

## 📍 Where things live (so you're not hunting)

| Thing | Where |
|---|---|
| Live status check (outside view) | `node scripts/status.mjs` |
| Which integrations are configured (inside view) | `/admin` → Launch readiness · `apps/api/src/ops/preflight.ts` |
| This dashboard | `docs/OPERATIONS.md` |
| Deploy mechanics + the Supabase/Railway connection gotcha | `docs/GO-LIVE-CHECKLIST.md`, `DEPLOY.md` |
| Backup + restore procedure | `docs/BACKUP.md` |
| Scale audit (the "will it hold at N shops" answer) | `docs/scale-readiness-audit.md` |
| Legal to-dos (LLC, insurance, subprocessors) | `LEGAL-CHECKLIST.md` |
| Web app (Vercel) | project `cuts-central-api` → getchairback.com |
| API (Railway) | `@chairback/api` → api.getchairback.com |
| DB (Supabase, prod) | project ref `czqjnhwxcubnskyfamvb` |
| Nightly backup job | `.github/workflows/backup.yml` → Cloudflare R2 `chairback-backups` |

### Emergency levers
- **Something is texting that shouldn't** → set `DRY_RUN=true` in Railway. Global kill switch for
  ALL sends (SMS + email + push).
- **Prod is down after a deploy** → check Railway logs for a migration error first
  (`column X does not exist` = code shipped ahead of its schema). Roll back code + schema together.
- **Never** `prisma db push` against prod — it wiped prod once. `migrate deploy` only.

---
*Keep this current: when you finish a checkbox, tick it and bump the review date. When a new
"only-you" task appears, add it here so future-you (and Claude) have one source of truth.*
