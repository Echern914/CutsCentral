# Releasing 1.1.8 (build 55) from the Mac

**Why now:** 1.1.7 (54) is Ready for Distribution, and four app changes merged
after it was archived. An app change reaches phones only through a new build.

**What's in it** (merged to `apps/mobile` after #702 set up 54):
- **Appointments booked together are one card** (#738): you and your kids
  booked as one party show as one card on My ChairBack. "See each appointment"
  opens it, "Hide appointments" closes it.
- **"Email me my link"** on Connect your profile (#750): the rewards link goes
  to the email the shop has for that profile.
- **Terms + Privacy tick before a sign-in code** (#715): unticked by default,
  and the code is not sent until it is ticked.
- **Manage plan opens billing in Safari** (#723): "Manage plan on
  getchairback.com" opens Safari, signed in, on the plans. No prices in the
  app. This is allowed because the app is on the US storefront only. It is
  NOT in What's New: store copy never points at purchasing.

Possibly already in 54, so re-checked on the device anyway: #706 (customer
screens read again on return), #709 (Book again opens the same service) and
#713 (an "opening just came up" push opens booking). 54 was archived on the
Mac, so its exact commit is not recorded.

Store copy and the App Review note: `apps/mobile/store/WHATS-NEW-1.1.8.md`.

The steps are the same as `docs/release-1.1.7.md`. The numbers, the checks and
step 0 change.

## 0. Before you start

- [ ] **Accept the updated Apple Developer Program License Agreement.** App
      Store Connect shows a banner until the **Account Holder** accepts it at
      developer.apple.com → Account. Until then Apple refuses uploads and
      submissions, so do this first.
- [ ] **Confirm 55 is the next number.** App Store Connect → ChairBack Rewards →
      TestFlight: the highest build uploaded must be **54** or lower. If a
      higher one is there, raise `buildNumber` in `apps/mobile/app.config.ts`
      above it first. Apple refuses a number it has already seen.
- [ ] 1.1.7 must be released (or still waiting) before 1.1.8 is submitted.
      Releasing 1.1.7 first is fine: 1.1.8 simply follows it.

## 1. Pull and install

```bash
cd ~/dev/CutsCentral
git checkout main && git pull
corepack pnpm install --frozen-lockfile
```

`apps/mobile/app.config.ts` must say `version: "1.1.8"` and `buildNumber: "55"`.

## 2. Prebuild and open the workspace

Build it the way 1.1.7 shipped. If 1.1.7 went out WITH the Lock Screen widget:

```bash
cd apps/mobile
NEXT_UP_WIDGET_ENABLED=true npx expo prebuild --platform ios --clean
open ios/ChairBackRewards.xcworkspace
```

If it went out without the widget, run `corepack pnpm run ios:xcode`.
Shipping without a widget that 1.1.7 had would remove it from people's Lock
Screens.

## 3. Signing

As in 1.1.7: each target → Signing & Capabilities → *Automatically manage
signing* → Team **ZLP9T7HSYJ**. General shows **1.1.8 (55)**.

## 4. Check it on your iPhone first

New in 1.1.8:
- [ ] Signed out → My ChairBack → start signing in. The Terms of Service and
      Privacy Policy box is **unticked**, and the send-code button stays
      greyed out until it is ticked. Both links open.
- [ ] A customer with a party booking (two people booked together): My
      ChairBack shows **one card**. "See each appointment" lists each person's
      appointment, and each one opens its own View details.
- [ ] My ChairBack → a shop's card → Connect your profile → **Email me my
      link**: a message shows under the button, and the email arrives at the
      profile's address. (Opened any other way, the screen has no such button.)
- [ ] Sign in as the shop owner → the plan or billing area → **Manage plan on
      getchairback.com ↗**: Safari opens on the plans, **signed in**. Check
      with an Apple-ID account if you have one; that path has not been tapped
      on a real iPhone yet. No price shows anywhere inside the app.

Re-checks (possibly already in 54):
- [ ] Barber moves a booking while the customer app is in the background →
      reopen → the new time shows without pull-to-refresh.
- [ ] My ChairBack → a past ChairBack visit → **Book again**: the booking page
      opens on that visit's service, at the times.
- [ ] An "An opening just came up" push → tap it → the booking page opens on
      that service.

Still fine from 1.1.7:
- [ ] Leave the dashboard in the background a few minutes, then come back:
      never a blank page.
- [ ] Cold start: the launch logo plays and goes away.
- [ ] An appointment → View details → **Add to Apple Wallet**.

## 5. Archive, upload, submit

**Product → Archive** → Organizer → **Distribute App → App Store Connect →
Upload**. When it appears in TestFlight: App Store Connect → **+ Version** →
**1.1.8** → add build **55** → paste the What's New text → append the App
Review note (both in `WHATS-NEW-1.1.8.md`) → **Submit for Review**.

## 6. After Apple releases it

Only once 1.1.8 is **live in the App Store**, set `IOS_MINIMUM_BUILD=55` on
Railway's API. Then anyone on 54 or older is asked to update. Never before: a
minimum above the live build tells everyone to update to something that isn't
there.

(While 1.1.8 is in review, `IOS_MINIMUM_BUILD=54` is safe once 1.1.7 is live.)
