# Releasing 1.1.7 (build 54) from the Mac

**Why now:** barbers on 1.1.6 (53) land on a blank page after the app has been
in the background, and only a force-quit gets them out (2026-10-26). The fixes
were merged after 53 was built, and an app change reaches phones only through
a new build.

**What's in it** (everything merged to `apps/mobile` since 53):
- **Never a blank dashboard** (#675): when iOS kills the page in the
  background, the app reloads it; a page left for 30+ minutes starts fresh; the
  loading spinner and the "Couldn't load" screen are readable (they were white
  on cream).
- **The page is checked on every return** (this release): the app asks the page
  to answer; no answer within 2 seconds, it reloads instead of showing blank.
  The automatic reload no longer runs out during a long day.
- **The launch logo can't get stuck** (this release): a timer removes it even if
  its animation never reports finishing.
- **The bar above a dark shop page is dark too** (#684).
- **Add to Apple Wallet** on an appointment's View details (#677).
- **Rewards tab: Your status**: every tier, what it takes and what it gets
  (#690).

Store copy: `apps/mobile/store/WHATS-NEW-1.1.7.md`.

The steps are the same as `docs/release-1.1.6.md`; only the numbers and the
checks change.

## 0. Before you start: confirm 54 is the next number

App Store Connect → ChairBack Rewards → TestFlight: the highest build uploaded
must be **53** or lower. If anything higher is there, raise `buildNumber` in
`apps/mobile/app.config.ts` above it first - Apple refuses a number it has
already seen.

## 1. Pull and install

```bash
cd ~/dev/CutsCentral
git checkout main && git pull
corepack pnpm install --frozen-lockfile
```

`apps/mobile/app.config.ts` must say `version: "1.1.7"` and `buildNumber: "54"`.

## 2. Prebuild and open the workspace

Build it the way 1.1.6 shipped. If 1.1.6 went out WITH the Lock Screen widget:

```bash
cd apps/mobile
NEXT_UP_WIDGET_ENABLED=true npx expo prebuild --platform ios --clean
open ios/ChairBackRewards.xcworkspace
```

If it went out without the widget: `corepack pnpm run ios:xcode`. (Shipping
without a widget that 1.1.6 had would remove it from people's Lock Screens.)

## 3. Signing

As in 1.1.6: each target → Signing & Capabilities → *Automatically manage
signing* → Team **ZLP9T7HSYJ**. General shows **1.1.7 (54)**.

## 4. Check it on your iPhone first

- [ ] Sign in as a barber. Open the camera, Instagram and a couple of other
      apps for a few minutes, then come back: the dashboard is there, or it
      reloads by itself within ~2 seconds. **Never a blank page.**
- [ ] Turn Wi-Fi and data off, open the app: you see a readable spinner, then
      "Couldn't load" with a Retry button you can read. Turn the network back on
      and tap Retry.
- [ ] Leave the app in the background for 30+ minutes: it comes back on a fresh
      dashboard.
- [ ] Cold start: the gold launch logo plays and goes away.
- [ ] My ChairBack → an appointment → View details → **Add to Apple Wallet**.
- [ ] My ChairBack → Rewards: **Your status** shows the tiers.
- [ ] Barber moves a booking while the customer app is in the background ->
      reopen -> new time shows without pull-to-refresh.
- [ ] A shop with a dark page → Book: the bar at the top is dark.
- [ ] My ChairBack → a past ChairBack visit → **Book again**: the booking page
      opens on that visit's service (and barber), scrolled to the times - not
      the shop's front page or the service menu. (Needs the API deployed with
      it; on an older API it opens the shop's page, as before.)

## 5. Archive, upload, submit

**Product → Archive** → Organizer → **Distribute App → App Store Connect →
Upload**. When it appears in TestFlight: App Store Connect → **1.1.7** → add
build **54** → paste the What's New text → **Submit for Review**.

## 6. After Apple releases it

Only once 1.1.7 is **live in the App Store**, set `IOS_MINIMUM_BUILD=54` on
Railway's API so anyone still on 53 or older is asked to update. Never before:
a minimum above the live build tells everyone to update to something that
isn't there.
