# Shipping the iOS app from Xcode (no EAS Build)

Builds are made on this Mac, in Xcode, for free. Expo the SDK stays exactly as
it is — `expo-router`, `expo-notifications`, every `expo-*` package, the config
plugins. What we stopped renting is EAS Build's cloud Mac.

`ios/` is **generated and gitignored** (`apps/mobile/.gitignore`). You never edit
it and never commit it. Everything native is decided by `app.config.ts` and the
plugin in `apps/mobile/plugins/`, and re-generated from them every time.
That rule is what keeps the native patches from silently disappearing — see
"What must never happen" below.

---

## 0. Before you build: are you pointed at the right app?

This Mac has built another app in Xcode. A wrong pick here is caught by Apple
rather than by you, so check once and know why it's safe:

| What | Must be | Where it's pinned |
|---|---|---|
| Bundle identifier | `com.getchairback.rewards` | `app.config.ts → ios.bundleIdentifier` |
| App Store Connect app | **6783995804** ("ChairBack Rewards") | `eas.json → submit.production.ios.ascAppId` |
| Team | the team that owns that bundle id in App Store Connect | you pick it in Xcode, step 3 |

**Why a wrong team can't upload to the wrong app:** a bundle identifier is
globally unique across every Apple developer team. If you select the other
app's team, Xcode cannot provision `com.getchairback.rewards` at all and stops
with *"No profiles for 'com.getchairback.rewards' were found"*. That is a safe
failure. Pick the other team and it goes away.

The team is **ZLP9T7HSYJ — Eric Chernichaw**. Verified 2026-09-11: it owns
`com.getchairback.rewards` (EAS's own App Store profile for the app is on this
team), and it is the same team as the other apps built on this Mac, so there is
only one to pick. Xcode creates the **Apple Distribution** cert the first time
you Distribute; that prompt is expected.

## 1. Version and build number — you own the counter now

EAS used to auto-increment the build number (`appVersionSource: "remote"`); its
counter stopped at **39**. `eas.json` now says `"local"`, so the number Apple
sees is `ios.buildNumber` in `app.config.ts`. **Every upload needs both bumped
by hand:**

- `buildNumber`: strictly greater than the last upload. Apple rejects a repeat.
- `version`: a new string once the previous one has been *submitted*. A version
  that was already submitted cannot take another build — that is how build 37
  died (`SUBMISSION_SERVICE_IOS_OLD_APP_VERSION`).

The history is in the comment above `version:` in `app.config.ts`. Keep
writing it there; it is the only record of which number carried what.

## 2. Build from the non-iCloud clone

Desktop is iCloud-synced and it corrupts `node_modules`, `Pods` and Xcode's
intermediate output. This is not folklore: on 2026-09-11 the Desktop clone's
`node_modules` held **2,477 iCloud-duplicated files** (`index 2.js`,
`package 2.json`, …), every native target compiled, and then Metro died on the
very first module with `Cannot read properties of undefined (reading
'getPackage')`. The identical branch bundled cleanly in `~/dev` on the first
try. Build from `~/dev/CutsCentral`:

```
cd ~/dev/CutsCentral
git pull
corepack pnpm install --frozen-lockfile
```

## 3. Generate the project and open it

```
cd apps/mobile
corepack pnpm run ios:xcode
```

That runs `expo prebuild --platform ios --clean` (which also runs `pod install`
and applies the config plugin) and opens `ios/ChairBackRewards.xcworkspace`.
**Always the `.xcworkspace`, never the `.xcodeproj`** — the project alone has no
Pods.

In Xcode:

1. Select the **ChairBackRewards** scheme and **Any iOS Device (arm64)**.
2. Target *ChairBackRewards* → **Signing & Capabilities** → tick
   *Automatically manage signing* → **Team**: the one that owns the bundle id.
   The bundle identifier field must already read `com.getchairback.rewards`; do
   not type into it.
3. Confirm the version and build shown under *General* match what you set in
   `app.config.ts`. If they don't, you edited the wrong file.

## 4. Archive and upload

**Product → Archive.** When the Organizer opens: **Distribute App → App Store
Connect → Upload**. Accept the defaults (Apple manages signing, symbols
included). Upload takes a few minutes; Apple then processes for 10–30 minutes
before the build appears in **TestFlight** and can be added to a release.

Release notes and the store listing are in App Store Connect as before; nothing
about submission changed except who made the binary.

## 5. If it fails

- **"Your team has no devices from which to generate a provisioning profile …
  No profiles for 'com.getchairback.rewards' were found"** — NOT the wrong
  team (that error reads *"An App ID with Identifier … is not available"*).
  Xcode signs the archive with a *development* profile first and only
  re-signs for the store on upload; a development profile needs at least one
  registered device, and EAS never needed one, so the team had zero. Register
  one: developer.apple.com → Devices → add your iPhone's UDID (Xcode → Window →
  Devices and Simulators shows it; or `xcrun devicectl list devices` then
  `device info details`). Plugging the phone in is not enough on its own unless
  Developer Mode is on (Settings → Privacy & Security). Then **Try Again**.
  Done once, 2026-09-11, with Eric's iPhone 16; the profile lasts a year.
- **"An App ID with Identifier 'com.getchairback.rewards' is not available"** —
  THAT one is the wrong team. See §0.
- **A C++ error in `fmt` mentioning `consteval`** — this was real on RN 0.76
  and Xcode 26, and a plugin (`withFmtConstevalFix`) patched fmt's source. RN
  0.81 ships fmt precompiled inside `ReactNativeDependencies`, so the plugin had
  nothing to patch and was removed after a full Release build compiled cleanly
  without it. If it ever comes back, the headers are now under
  `Pods/ReactNativeDependencies/Headers/fmt/`; restore the plugin from git
  history against that path.
- **`pod install` complains a Swift pod can't be a static library
  (AppCheckCore / GoogleUtilities)** — `plugins/withGoogleModularHeaders.js`
  didn't run. You built from a hand-edited `ios/`; delete it and re-run step 3.
- **"Bundle React Native code and images" fails with `Cannot read properties
  of undefined (reading 'getPackage')`** — Metro's file map is broken because
  `node_modules` is iCloud-damaged. Not a code problem. Build from
  `~/dev/CutsCentral`; if it happens there, `rm -rf node_modules && corepack
  pnpm install --frozen-lockfile`.
- **Anything else weird about missing files or stale caches** — you're building
  from Desktop. Go to `~/dev/CutsCentral`.
- **Build phase "Bundle React Native code and images" can't find node** — Xcode
  didn't inherit your shell. Set `NODE_BINARY` in `ios/.xcode.env.local` to the
  output of `which node`. (That file is generated too; it's fine to create it.)

## What must never happen

**Do not hand-edit anything under `ios/`.** Not a build setting, not a plist
key, not the Podfile. It all comes back next `prebuild --clean` exactly as
`app.config.ts` says — and anything you changed by hand is gone, including any
native patch you didn't know was load-bearing. Native config changes go in
`app.config.ts` or a config plugin, get committed, and are regenerated.

**Do not commit `ios/`.** It is 1–2 GB with Pods and it is not the source of
anything.

## Going back to EAS

Nothing was removed. `eas.json` still has the profiles; `eas build --platform
ios --profile production` still works if the Mac is unavailable. Keep
`appVersionSource: "local"` — EAS will then read the number from
`app.config.ts` too, so the two paths can't disagree about it.
