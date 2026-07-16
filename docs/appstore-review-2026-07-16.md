# App Store rejection response — build 1.0 (31), review of 2026-07-16

Submission `06faa402-56a5-47db-81ca-0466b6b64c54` rejected on three guidelines.
This doc pairs with the `feat/appstore-review-fixes` PR: what changed in code,
what to do in App Store Connect, and the reply text to send.

## Why build 31 failed (root causes found in code review)

1. **2.1(a)** — the native sign-in screen offered ONLY Apple/Google (no
   email+password), so demo credentials were unusable in-app, and customer mode
   required a magic-link token the reviewer didn't have. There was no
   demonstration mode reachable from the app.
2. **3.1.1 / 3.1.3(c)** — the billing UI was already hidden in-app, but
   (a) the WebView had no navigation policy, so the marketing landing (with the
   full pricing section) was reachable in-app, and (b) `HideInNativeApp` only
   hid content AFTER React hydration — server-rendered prices flashed on every
   in-app page load before being removed.
3. **4.8** — the native Apple button was gated on
   `AppleAuthentication.isAvailableAsync()`; a false negative silently left
   Google as the only option. The web /login page (Google + password, no Apple)
   was also reachable inside the WebView.

## What the PR changes

- **Demo modes (2.1a).** Barber sign-in gains "Just looking? Explore the demo"
  → `/demo/dashboard` (anonymous read-only session on the seeded demo tenant,
  guided tour armed). Customer mode gains "Just looking? Try the demo" → the
  seeded demo client's rewards page (fixed public token). Neither registers
  push nor persists.
- **Email + password sign-in (2.1a, product gap).** The native sign-in screen
  now has an email/password form against the existing `/api/auth/login` (it
  already returns the JWT for native clients). Web-signup barbers can finally
  log into the iOS app — and App Review gets a classic demo account.
- **Sign in with Apple always renders on iOS (4.8).** The availability probe is
  gone.
- **WebView navigation policy (3.1.1, 4.8).** Full document navigations to
  `/`, `/login`, `/signup`, `/forgot-password` open in Safari instead of the
  shell. (SPA navigations bypass native handlers, so the same pages also hide
  the forbidden UI themselves — see next.)
- **First-paint hiding (3.1.1).** The shell injects
  `[data-native-hide]{display:none}` before any content loads;
  `HideInNativeApp` now wraps children in a `display:contents` span carrying
  that attribute. No more price flash while React hydrates.
- **Web-side hiding extended.** The landing pricing nav link, the whole pricing
  section, and the "How much does it cost?" FAQ answer are hidden in-app; the
  web login/signup Google button is hidden in-app (the in-app web form is
  email/password only, which is exempt from 4.8); the four "upgrade from the
  Billing page" toasts use neutral copy in-app.

## Checklist before resubmitting (build 32)

1. Merge the PR; confirm Vercel deployed the web changes to production.
2. **Re-seed the prod demo tenant with rich data** (the pending
   `seed --allow-prod` from the demo-tour work). The demo MUST look full —
   "pre-populated content" is part of the 2.1(a) ask. Verify:
   - `getchairback.com/demo/dashboard` shows a busy dashboard (clients,
     appointments, punch cards, inbox threads).
   - `getchairback.com/r/demo-rewards-b91e57a3c40d268f7e13` shows a filled
     punch card + visit history.
3. Create a dedicated review account (email+password) on prod, e.g.
   `applereview@chairback.app`, owner of a seeded shop with data (or comp it to
   Premium AI so every tier-gated feature is visible). Do NOT hand out the
   `demo@chairback.app` owner (its sessions are anonymous/read-only by design).
4. `eas build` + submit build 32.
5. In App Store Connect → App Review Information:
   - Fill in the demo account username/password from step 3.
   - Paste the review notes below.
6. Reply to the rejection message with the reply text below.

## App Review Information — notes field

> ChairBack is a business tool for barbershops with a companion customer view.
> The first screen asks which role you are:
>
> BARBERSHOP OWNER: choose "I own a barbershop", then either sign in with the
> demo account (credentials above) using the email & password fields, or tap
> "Just looking? Explore the demo" for a no-account, read-only demonstration of
> the full dashboard with a guided tour and pre-populated data.
>
> CUSTOMER: customers have no accounts or passwords — a barber texts them a
> private magic link. Choose "I'm a customer", then tap "Just looking? Try the
> demo" to open a fully populated demo customer rewards page (punch card,
> visit history, booking).
>
> Subscriptions: ChairBack plans are business services sold to barbershops.
> They are purchased on our website only; the app contains no purchase flow,
> pricing, or links to external purchase.

## Reply to App Review (message thread)

> Hello, and thank you for the detailed review. Build 32 addresses all three
> issues:
>
> **Guideline 2.1(a):** We've added a demo account (see App Review Information)
> plus built-in demonstration modes for BOTH roles: "Explore the demo" on the
> owner sign-in screen opens a read-only, fully populated dashboard with a
> guided tour, and "Try the demo" in customer mode opens a populated demo
> rewards page. Note that real customers never have accounts — they receive a
> private magic link by SMS from their barber, which is why no customer
> credentials exist.
>
> **Guidelines 3.1.1 / 3.1.3(c):** ChairBack's subscriptions are business
> services sold to barbershop businesses to run their operations (booking,
> client management, SMS campaigns); they are not consumer digital content. As
> of this build the app contains no purchase flow, no plan pricing, and no
> links or calls to action directing to an external purchase — plans are
> purchased on our website, and the app is used to access an existing business
> account (as with other business SaaS apps).
>
> **Guideline 4.8:** The app offers Sign in with Apple as the first sign-in
> option on the owner sign-in screen, ahead of Google, alongside our own
> email/password login. Sign in with Apple limits data collection to name and
> email, lets users hide their email address, and collects no advertising
> data. In build 31 the Apple button was gated behind an availability check
> that could suppress it; in build 32 it renders unconditionally on iOS.
>
> Thank you — happy to provide anything else that would help.

## Notes / follow-ups

- The nav-policy blocklist is deliberately tiny (`/`, `/login`, `/signup`,
  `/forgot-password`); everything else (booking, shop pages, legal pages)
  stays in-app. Legal pages in-app are good for review.
- `DEMO_REWARDS_TOKEN` in `apps/mobile/src/config.ts` mirrors
  `DEMO.MAGIC_TOKEN` in `packages/config/src/demo.ts` (the app doesn't import
  workspace packages). If the seeder contract ever changes, change both.
- This branch is off `main` and will conflict lightly with
  `feat/ada-accessibility` (PR #85) in `Landing.tsx` / `PromotionsManager.tsx`
  / `AuthForm.tsx`; whichever lands second rebases.
