# Releasing 1.1.6 (build 51) from the Mac

**What's in it:** white & gold screens/splash/status bar, the Lock Screen
widget, and the app fixes merged since build 50 (#606, #615, #634, #636).
Store copy: `apps/mobile/store/WHATS-NEW-1.1.6.md`.

The general steps are `docs/mobile-release-xcode.md`; the widget's are
`docs/lock-screen-widget.md`. This is the two of them in order, for this build.

## 1. Pull and install (the non-iCloud clone)

```bash
cd ~/dev/CutsCentral
git checkout main && git pull
corepack pnpm install --frozen-lockfile
```

Confirm `apps/mobile/app.config.ts` says `version: "1.1.6"` and
`buildNumber: "51"`.

## 2. Prebuild WITH the widget, and open the workspace

```bash
cd apps/mobile
NEXT_UP_WIDGET_ENABLED=true npx expo prebuild --platform ios --clean
open ios/ChairBackRewards.xcworkspace
```

🔴 Not `pnpm run ios:xcode` this time: that prebuilds **without** the flag and
leaves the widget out.

The project should show two targets: **ChairBackRewards** and **NextUp**.

## 3. Signing (both targets)

For **ChairBackRewards** and then **NextUp**: Signing & Capabilities →
*Automatically manage signing* → Team **ZLP9T7HSYJ (Eric Chernichaw)**.
Both must list the App Group **`group.com.getchairback.rewards`**. If Xcode
offers to create or register the group, let it.

Under *General*, ChairBackRewards shows **1.1.6 (51)**.

## 4. Check it on your iPhone first

Run it on the phone (pick your iPhone as the destination, ▶). Then:

**Look:**
- [ ] The launch screen is white with the gold chair.
- [ ] The role picker, sign-in and My ChairBack screens are white & gold, and
      the status bar (clock, battery) is dark and readable.
- [ ] Dashboard → Account → Appearance → **Black & Gold**: the dashboard turns
      dark and the status bar icons turn white. Switch back to White & Gold.
- [ ] My ChairBack → open a shop whose page is **dark** (Classic Gold), then
      **Book**: the bar with **Done** at the top is dark too (no cream strip),
      the clock is readable, and loading never flashes cream. A shop with a
      light page (Crisp Light) keeps the cream bar.

**Widget** (from `docs/lock-screen-widget.md`; book yourself a test
appointment later today first):
- [ ] Long-press the Lock Screen → Customize → Lock Screen → add **ChairBack →
      Next up**. It shows the time, first name and service, matching the
      dashboard.
- [ ] Book someone else from another device; open the app; the widget updates.
- [ ] Account → Notifications → turn off "Client names on the lock screen",
      reopen the app: time and service only.
- [ ] Tap the widget: the app opens on that booking.
- [ ] Sign out: the widget says "Signed out".

If any widget check fails, don't ship it broken: prebuild again **without** the
flag (`corepack pnpm run ios:xcode`), and remove the widget paragraph from the
What's New text.

## 5. Archive and upload

Destination **Any iOS Device (arm64)** → **Product → Archive** → Organizer →
**Distribute App → App Store Connect → Upload**. Apple processes it in 10–30
minutes, then it appears in TestFlight.

## 6. Submit

In App Store Connect → ChairBack Rewards → **1.1.6** → add build **51** →
paste "What's New" from `apps/mobile/store/WHATS-NEW-1.1.6.md` →
**Submit for Review**.

## 7. After Apple releases it

Only once 1.1.6 is **live in the App Store** (released, not just approved), you
can set `IOS_MINIMUM_BUILD=51` on Railway's API to ask older builds (49, 50) to
update. Never before: a minimum above the live build tells everyone to update
to something that isn't there.
