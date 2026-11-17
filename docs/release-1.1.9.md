# Releasing 1.1.9 (build 56) from the Mac

**Why now:** 1.1.8 (55) is approved and ready to distribute. It did not carry
the Studio redesign on the app's own customer tabs (Home, Book,
Appointments, Rewards, Profile): the redesign was a web change, and those tabs
are native screens. They still had the gold "View details" button on cream.
An app change reaches phones only through a new build.

**What's in it** (merged to `apps/mobile` after #774 set up 55):
- **My ChairBack in the Studio look.** The same colours as the web
  (`apps/web/src/app/globals.css`): paper background, white cards, **ink**
  primary buttons with white text, and gold only as an accent (links, the
  selected tab, progress, stamps). The ChairBack wordmark is ink. Status dots
  use the web's status colours. `src/customer/studioTheme.test.ts` holds the
  app's tokens to the web's.
- **Directions open the Maps app** (#776). A shop page's Directions inside the
  app now leave for Apple or Google Maps instead of loading a map inside the
  app with no way back. Builds before 56 hide the Directions tile.

Not restyled in this build: the role picker, the barber sign-in and the join
screen, which carry their own colours, and the launch scene, which has to match
the native splash image.

Store copy: `apps/mobile/store/WHATS-NEW-1.1.9.md`.

The steps are the same as `docs/release-1.1.8.md`. Only the numbers and the
checks change.

## 0. Before you start

- [ ] **Confirm 56 is the next number.** App Store Connect → ChairBack Rewards →
      TestFlight: the highest build uploaded must be **55** or lower. If a
      higher one is there, raise `buildNumber` in `apps/mobile/app.config.ts`
      above it first.
- [ ] Release 1.1.8 first (or leave it waiting). 1.1.9 simply follows it.

## 1. Pull and install

```bash
cd ~/dev/CutsCentral
git checkout main && git pull
corepack pnpm install --frozen-lockfile
```

`apps/mobile/app.config.ts` must say `version: "1.1.9"` and `buildNumber: "56"`.

## 2–3. Prebuild, open, sign

As in `docs/release-1.1.8.md` steps 2 and 3. General shows **1.1.9 (56)**.

## 4. Check it on your iPhone first

New in 1.1.9:
- [ ] My ChairBack → Home: the background is paper, cards are white, the
      **View details** button is **black with white text** (not gold), and
      "ChairBack" at the top is black.
- [ ] Book, Appointments, Rewards and Profile: every main button is black;
      "See all" and similar links are gold text; the selected tab is gold.
- [ ] Rewards: the stamps and the progress bar are still gold.
- [ ] Tap a button and hold it: it darkens slightly, and its label stays
      readable.
- [ ] A shop page whose barber turned Directions on → **Directions** → the
      Maps app opens on the shop's street address. Switch back to ChairBack:
      you are where you left off.

Still fine from 1.1.8:
- [ ] Signing in still asks for the Terms and Privacy tick before a code.
- [ ] A party booking is still one card.
- [ ] Cold start: the launch logo plays and goes away.

## 5. Archive, upload, submit

As in 1.1.8: **Product → Archive** → Upload → App Store Connect → **+ Version**
→ **1.1.9** → build **56** → paste the What's New text → **Submit for Review**.

## 6. After Apple releases it

Only once 1.1.9 is **live in the App Store**, you may set
`IOS_MINIMUM_BUILD=56` on Railway's API. Never before.
