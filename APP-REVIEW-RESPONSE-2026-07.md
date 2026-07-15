# App Store review responses — July 2026 (round 3 on top, round 2 kept below)

---

# ROUND 3 — Submission 0b0024e5 (v1.0 build 30), rejected 2026‑07‑15

Apple rejected build 30 on 1.5 (support URL still 404), 2.1(a) (no way to access
customer accounts / no usable demo account), and 3.1.1 + 3.1.3(c) (in‑app business
registration; enterprise services also sold to individuals). Sections: (R1) what
actually went wrong, (R2) the code fixes on `fix/appstore-review-round3`, (R3) the
reply to paste, (R4) demo‑account setup + App Review notes text, (R5) the build‑31
checklist.

## R1. What actually went wrong

- **1.5 Support URL:** the round‑2 fixes (including `/support`) live on branch
  `fix/appstore-review-round2`, which was **never merged to `main`** — so Vercel never
  deployed the page and it 404'd for the reviewer, even though build 30 shipped the
  in‑app fixes. Verified: `origin/main` has no `apps/web/src/app/support/` and the live
  URL returns 404.
- **2.1(a) customer accounts:** the app's barber sign‑in was Apple/Google only, so the
  "demo barber account (email + password)" from round 2 was **unusable inside the app**
  — a reviewer cannot type credentials into an OAuth sheet. And the customer side is
  magic‑link auth; if no fresh prepopulated link was in the review notes (or the link
  was killed by testing the deletion flow, which rotates the token), the reviewer had
  no way into a customer account.
- **3.1.1 registration:** with only OAuth buttons, a reviewer signing in with a fresh
  Apple ID **auto‑created a business account** (`signInWithProfile` step 3) and landed
  in shop onboarding — that's the "account registration feature for businesses" Apple
  flagged as access to an external purchase mechanism.
- **3.1.3(c):** a policy/positioning question, answered in the reply (R3): ChairBack is
  sold to businesses only; the consumer side is free; there is no purchase surface in
  the app (the billing/upgrade UI is already hidden in‑app via `HideInNativeApp` /
  `useIsNativeApp`, shipped on `main`).

## R2. Code fixes (branch `fix/appstore-review-round3`, stacked on round 2)

| Issue | Fix | Files |
|---|---|---|
| 3.1.1 in‑app registration | Native Apple/Google sign‑in is now **login‑only**: a token that matches no existing account gets a uniform `account_not_found` 403 — no account is ever created from the app. Sign‑up stays web‑only. | `apps/api/src/auth/native.ts`, `apps/api/src/routes/auth.ts`, tests in `apps/api/src/auth/native.test.ts` |
| 2.1(a) demo access | **Email + password sign‑in** added to the app's sign‑in screen (uses the existing `/api/auth/login`, which already returns a bearer token). This is how the reviewer's typed demo credentials work. Friendly "No ChairBack account found…" message for `account_not_found`. Keyboard‑avoiding + scrollable (the round‑2 iPad lesson). | `apps/mobile/app/login.tsx` |
| 2.1(a) prepopulated demo | `review:seed` script creates the **App Review account**: email+password user + "Uptown Fades" shop, comped Premium, 8 clients with visits/punches/tiers/at‑risk rows, all SMS sending defused, prints credentials + two customer rewards links (browse + deletion‑test). Idempotent — rerun to mint fresh links. | `apps/api/scripts/seed-appreview.ts`, `apps/api/package.json`, keep‑listed in `apps/api/scripts/clean-fake-data.mjs` |
| 3.1.1 leftover upgrade copy | The four "upgrade from the Billing page" strings (toasts + sweep error) now drop the upgrade steering when inside the app shell. | `ClientsList.tsx`, `RebookPanel.tsx`, `PromotionsManager.tsx`, `SweepControl.tsx` (all under `apps/web/src/app/dashboard/`) |

Notes: the login‑only change is **server‑side** — it takes effect for build 30 the
moment the API deploys. Build 31 is still required for the email sign‑in form (there is
no other way to give Apple working demo credentials). The public read‑only demo tenant
(`seedDemoShop.ts`) is NOT sufficient for review — demo sessions reject writes and its
owner has no password.

## R3. Reply to paste into App Store Connect (round 3)

> Hello, and thank you for the additional review. We've addressed each item; details
> below. A new build (31) accompanies this reply.
>
> **Guideline 1.5 — Support URL.** This was a deployment fault on our side: the support
> page existed in the app release but had not been published to our website when your
> review ran. It is now live at https://getchairback.com/support (support email,
> response time, account/data deletion steps, FAQ).
>
> **Guideline 2.1(a) — Demo account access.** We've added email + password sign‑in to
> the app and created a dedicated, fully prepopulated review account — credentials are
> in the App Review Information section. The business dashboard demo account has full
> feature access (client book, loyalty, at‑risk list, promotions, account deletion).
> For the customer side, the app's customer mode is opened with a rewards link (this is
> how real customers use it — they never create accounts or passwords); the App Review
> notes include two prepopulated rewards links: one for browsing all customer features
> and one reserved for testing the "Delete my data" flow (deleting kills that link by
> design).
>
> **Guideline 3.1.1 — Account registration.** We have removed account registration for
> businesses and organizations from the app. Signing in with Apple, Google, or email
> can only access an existing account; no account of any kind can be created inside
> the app. The app also contains no pricing, subscription, upgrade, or payment UI.
>
> **Guidelines 3.1.1 / 3.1.3(c) — Enterprise services.** ChairBack's paid service is
> sold only to businesses and organizations (barbershops, salons, and similar service
> businesses), billed to the business on our website. It is not sold to single users,
> consumers, or for family use — the only consumer‑facing part of the app (a shop's
> customers viewing their loyalty punch card) is free for everyone and has nothing to
> purchase. Per Guideline 3.1.3(c), and with registration and all purchase surfaces
> removed from the app, we believe no In‑App Purchase is required. We're happy to
> provide any further detail.
>
> Thank you again for your patience.

## R4. Demo accounts + App Review notes (do after web+API deploy)

1. Seed the review account **against production** (Railway env):
   `railway run pnpm --filter @chairback/api review:seed <pick-a-strong-password>`
   (or run locally with the prod `DATABASE_URL`). It prints the credentials block +
   two customer links. **Rerun it anytime** — e.g. after Apple tests deletion — to
   mint fresh links; put the new links in the review notes before resubmitting.
2. **App Review Information → Sign‑in required:** username `appreview@getchairback.com`,
   password = what you chose.
3. **App Review notes** — paste something like:
   > BUSINESS/BARBER SIDE: choose "I own a barbershop", then sign in with the email +
   > password above (tap the email fields under "or use your email"). The demo shop
   > "Uptown Fades" is fully populated (clients, loyalty punch cards, at‑risk list).
   > Account deletion: Dashboard → Account → Delete account.
   >
   > CUSTOMER SIDE: customers never register — their barber texts them a private
   > rewards link (this is the whole auth model). Choose "I'm a customer" and paste:
   > • Browse all customer features: <link 1 from the seed script>
   > • For testing "Delete my data": <link 2> (deletion permanently kills this link;
   >   that is the expected behavior)
   >
   > Note: in‑app account registration is intentionally not possible (Guideline 3.1.1
   > — business accounts are created outside the app).
4. Re‑attach / keep the **deletion screen recording** from round 2 if ASC still has it.

## R5. Build‑31 checklist

**Order matters: deploy web + API to production BEFORE building/submitting**, so
`/support` is live, `account_not_found` is being returned, and the toasts are gated.

1. In `~/dev/CutsCentral` (never the iCloud checkout): fetch, check out
   `fix/appstore-review-round3`, `pnpm install`, `pnpm --filter @chairback/db generate`.
2. Validate: `pnpm --filter @chairback/api typecheck && pnpm --filter @chairback/api test`,
   `pnpm --filter @chairback/mobile typecheck`, web typecheck vs the known‑red baseline.
3. PR `fix/appstore-review-round3` → `main`, merge (it contains round 2; one merge
   deploys both). Verify live: `https://getchairback.com/support` → 200; support
   mailbox actually receives mail.
4. Seed the review account + write the ASC fields/notes (section R4).
5. Build: from `~/dev/CutsCentral/apps/mobile`,
   `eas build -p ios --profile production --auto-submit` (buildNumber → 31, EAS‑managed).
   Sanity‑check on a real device: fresh Apple ID sign‑in shows the friendly
   "No ChairBack account found…" (not a raw error), email sign‑in works with the
   review credentials, no Billing nav item, no trial banner.
6. Reply to Apple with R3 + resubmit.

---

# ROUND 2 — Submission a5992b7d (v1.0 build 29) — kept for history

Apple rejected build 29 on four guidelines. This doc has (A) the code fixes and where
they live, (B) the exact reply to paste into App Store Connect, (C) the business‑model
answers for 2.1(b), (D) the account‑deletion demo scripts for the required screen
recording, and (E) the resubmission checklist (the parts only you can do).

---

## A. What the code changes fix

| Guideline | Fix | Files |
|---|---|---|
| 2.1(a) customer login button hidden on iPad | Wrapped the customer entry form in `KeyboardAvoidingView` + `ScrollView` (`keyboardShouldPersistTaps="handled"`), so the button is always visible/tappable when the keyboard is open. | `apps/mobile/app/customer.tsx` |
| 1.5 Support URL 404 | New public support page (contact email, response time, account/data deletion, FAQ), added to sitemap. | `apps/web/src/app/support/page.tsx`, `apps/web/src/app/sitemap.ts`, `apps/web/src/components/legal/Legal.tsx` (added optional `hideDate`) |
| 5.1.1(v) no customer deletion | New anonymizing `POST /api/rewards/:magicToken/delete` + themed "Delete my data" control on the rewards page + native token cleanup. Barber/manager deletion already exists (Dashboard → Account → Delete account). | `apps/api/src/routes/rewards.ts`, `apps/web/src/app/r/[magicToken]/DeleteMyData.tsx`, `.../actions.ts`, `.../RewardsClient.tsx`, `apps/mobile/app/customer.tsx`, tests in `apps/api/src/routes/rewards.test.ts` |
| 2.1(b) business model | No code change — answer the questionnaire (section C). No IAP anywhere in the app; subscription is sold on the web to businesses; currently free. | — |

**Customer deletion = anonymize, not hard delete.** The client's identifiers are
erased (name, phone, email, notes), the magic link is rotated so it's dead (404s),
push devices + wallet passes are removed, the client's name is scrubbed out of any
sent‑text log rows and native‑booking snapshots, and the row is marked opted‑out +
archived (drops off the shop's book, keeps a de‑identified visit count and a TCPA
opt‑out record). Result: no identifiable data survives, and the shop isn't silently
missing history.

---

## B. Reply to paste into App Store Connect

> Hello, and thank you for the detailed review. We've addressed all four items in a new
> build (build 30). Details below.
>
> **Guideline 1.5 — Support URL.** Our support page is now live and functional at
> https://getchairback.com/support. It lists our support email
> (support@getchairback.com), our response time, in‑app account/data deletion steps,
> and an FAQ. The Support URL in App Store Connect points to this page.
>
> **Guideline 2.1(a) — Customer login button on iPad.** Thank you for catching this.
> On the customer screen the on‑screen keyboard could cover the action button because
> the form wasn't scrollable/keyboard‑aware. We've made the screen keyboard‑avoiding
> and scrollable, so the button is always visible and tappable on iPad and iPhone.
> Fixed in build 30.
>
> **Guideline 5.1.1(v) — Account deletion.** The app supports in‑app deletion for both
> user types:
> • Shop owners/managers (who sign in with Apple/Google): Dashboard → Account →
>   "Delete account" → confirm by typing your email → "Permanently delete account."
>   This deletes the login and all shop data and cancels any subscription.
> • Rewards users (clients): open the rewards page → "Delete my data" at the bottom →
>   confirm. This erases their personal information and disables their link.
> A screen recording of both flows and a demo account are in the App Review notes.
>
> **Guideline 2.1(b) — Business model.** Answered in full below. In short: ChairBack is
> B2B software that barbershop/salon businesses use to run client rebooking and
> loyalty. The subscription is sold to the business on our website via Stripe; there is
> no in‑app purchase and nothing is sold inside the app. The service is currently free
> for all users during an introductory period. See the detailed answers below.
>
> [paste the five answers from section C]
>
> Thank you again — happy to provide anything else you need.

---

## C. Guideline 2.1(b) — business‑model answers

These are honest and reflect current state (no one is being charged yet). Do **not**
claim there is no paid plan — the price is visible on the web dashboard, so accuracy
matters. The point that keeps you out of In‑App Purchase is true on its own: this is a
B2B business‑management subscription sold on the web, not consumer digital content.

**1. Who are the users that use the paid content, subscriptions, or features?**
The paying users are our business customers — independent barbershop, salon, and spa
owners/operators. ChairBack is B2B software a business uses to run client rebooking,
retention, and loyalty. The subscription attaches to a business account ("Shop"); the
owner subscribes on behalf of the business, and their staff use the same dashboard
under that account. The shops' own end‑clients (the people getting haircuts) are never
charged — they use a free loyalty/rewards page.

**2. Where can users purchase the paid content, subscriptions, or features?**
Only on our website (getchairback.com), on the web billing dashboard, through
Stripe‑hosted checkout. Payment, card entry, invoices, and cancellation are all handled
by Stripe's hosted checkout and customer portal. The subscription is not, and cannot be,
purchased inside the iOS app — the app contains no purchase, upgrade, or pricing screen.

**3. What previously‑purchased content, subscriptions, or features can a user access in
the app?**
A business that has an account can sign in on iOS and view its own business dashboard —
its client book, loyalty/punch data, at‑risk‑client list, and the status of its
automated rebooking texts — rendered from our web app. The app surfaces only the shop's
own operational business data; it grants no consumable digital goods, media, or
entertainment content.

**4. What paid content, subscriptions, or features are unlocked without using In‑App
Purchase?**
The Premium plan is a B2B business‑management (SaaS) service the business purchases on
our website via Stripe; under the multiplatform/business principles of Guideline 3.1.3
it does not require In‑App Purchase, and the app itself sells nothing and contains no
IAP. Importantly, **the service is currently offered free to all users during an
introductory period — no user is being charged at this time.** A business signs up and
(later, when billing begins) would pay on the web; the app is only used to operate the
account.

**5. Are the enterprise/business services sold to single users, consumers, or for family
use?**
They are sold to businesses. Each subscription is a single business account (one
barbershop/salon/spa), purchased by that business's owner to manage the business. It is
not sold to individual consumers for personal use and is not a family‑sharing plan.

---

## D. Account‑deletion demo (record this on a real device, attach to App Review notes)

Apple asks for a screen recording showing sign‑in → find deletion → complete deletion.
Record **both** flows (or at least the customer flow the reviewer tested, plus the
barber flow):

**Barber/manager (the account‑creation path):**
1. Launch the app → "I own a barbershop" → sign in (demo account, see checklist).
2. In the dashboard, scroll to the **Account** section.
3. Tap **Delete account** → type the account email to confirm → **Permanently delete
   account.** The app returns to signed‑out state; the account and its data are gone.

**Customer (rewards user):**
1. Launch the app → "I'm a customer" → open a rewards link (demo link, see checklist).
2. Scroll to the bottom of the rewards page → tap **Delete my data** → **Delete my
   data** to confirm.
3. The page shows "Your data has been deleted"; the link is now dead.

---

## E. Resubmission checklist (only you can do these)

Do them roughly in this order. **Deploy web + API before building the app**, because the
customer‑deletion UI and support page need to be live for the reviewer.

1. **Validate the code in a working checkout** (this iCloud copy has no usable
   `node_modules`). In `~/dev/CutsCentral`, sync these changes (merge/cherry‑pick this
   branch), then:
   - `pnpm install`
   - `pnpm --filter @chairback/db generate`  ← required so `tx.walletPassRegistration`/
     `tx.appointment` type‑check (the checked‑in generated client predates the wallet model)
   - `pnpm --filter @chairback/api typecheck` and `pnpm --filter @chairback/api test`
     (the new `rewards.test.ts` delete block runs)
   - `pnpm --filter @chairback/mobile typecheck`
   - Web typecheck has a known‑red baseline; confirm no *new* errors in the support page
     or `RewardsClient`/`DeleteMyData`.
2. **Merge to `main`** so Vercel (web) and Railway (API) deploy. Note: this branch
   (`feat/gcal-sync`) also carries the Google Calendar work — decide whether you want
   both in this release or want to split these App Store fixes onto their own branch.
3. **Verify live:** `https://getchairback.com/support` returns 200, and open a real
   rewards link → confirm the **Delete my data** control appears and works.
4. **Confirm the support mailbox is live** — `support@getchairback.com` must actually
   receive mail (LEGAL‑CHECKLIST.md flagged the forward as a TODO). A Support URL that
   lists an unmonitored address still fails the spirit of 1.5.
5. **App Store Connect → App Information / this version:**
   - Set **Support URL** to `https://getchairback.com/support`.
   - **App Review notes:** paste the deletion steps (section D), and provide a **demo
     barber account** (email + password) and a **demo customer rewards link** so the
     reviewer can exercise both deletion flows. Attach the **screen recording**.
6. **Build 30:** from `~/dev/CutsCentral/apps/mobile`, bump the version if you like, then
   `eas build -p ios --profile production --auto-submit` (buildNumber auto‑increments).
   Native sign‑in only works on a real device, not the simulator.
7. **Reply to Apple** in App Store Connect with the message in section B (including the
   five answers from section C), then submit build 30 for review.

---

*Notes:* The customer "Delete my data" flow is intentionally an **anonymize**, chosen
over hard delete so you keep TCPA opt‑out records and don't silently lose shop history —
identifiable data is still fully erased, which is what 5.1.1(v) requires. The barber
deletion was left where it is (Dashboard → Account); the reviewer missed it because they
only tested the customer section and had no demo barber account — the review notes + demo
account in step 5 close that gap.
