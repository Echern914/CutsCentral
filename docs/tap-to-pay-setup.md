# Tap to Pay on iPhone — setup, and the device build that is now proven

Most of this file is an account, an approval or a device: things no repository
change can create. What has changed since the first version of this document is
that **the development device build has now been done**, locally in Xcode, and
the entitlement has been read back out of the signed binary.

Read the checklist in order. Step 1 is the long pole because Apple decides the
timing.

---

## Status: what is proven and what is not

| | proven? |
|---|---|
| The app compiles, links, signs and installs with the entitlement on | **yes** — local Xcode device build, 2026-09-22 |
| `StripeTerminal.framework` is in the app bundle | **yes** |
| The JS bundle is told it may announce the capability | **yes** |
| A real payment works | **no** |
| TestFlight / App Store can carry this | **no** — needs Apple's *distribution* entitlement and a new build |

🔴 **Armed is not working.** Everything above proves the binary is correctly
built and signed. It proves nothing about taking money. See "The release check"
at the bottom.

🔴 **Build 43 in TestFlight does NOT contain this entitlement.** It was built
with the flag off. Tap to Pay cannot be tested from TestFlight today.

🔴 **The Wallet module compiling in this build says nothing about Wallet
passes.** Appointment passes depend on backend certificate configuration
(`WALLET_APPT_*`), which is a separate concern entirely.

---

## 0. The flag: `TAP_TO_PAY_NATIVE_ENABLED`

Defaults to **false**, so an ordinary build signs and ships exactly as before:
no entitlement, no location permission string, and the shell tells the dashboard
nothing, so checkout reads "Not set up on this device yet".

Accepted as on: `true`, `1`, any casing, surrounding spaces. **Anything else —
`yes`, `on`, a typo — reads as off**, because a mistyped build script must not
be what puts an ungranted entitlement into a binary.

🔴 **One flag, three consequences, deliberately inseparable.** It adds the
entitlement, adds the Stripe Terminal config plugin (Info.plist permission
strings), *and* tells the JS bundle it may announce the capability. A binary
that advertises Tap to Pay without the entitlement hands the barber a button
that dies at the reader with a customer standing in front of them.
`apps/mobile/src/tapToPay/appConfig.test.ts` asserts the three can never
disagree.

---

## 1. Apple: the DEVELOPMENT entitlement — required first

`com.apple.developer.proximity-reader.payment.acceptance`, granted per bundle
id — ours is `com.getchairback.rewards`.

Apple must **grant** it, and Tap to Pay must additionally be **enabled on the
App ID** for that bundle id. Both, not either. A build carrying the entitlement
cannot sign until the grant lands, which is why the flag defaults off.

**Apple takes no cut.** The entitlement is permission to use NFC hardware. A
haircut is a real-world service, expressly excluded from in-app purchase, so
payments go card → Stripe → the barber.

## 1b. Apple: the DISTRIBUTION entitlement — later

Requested **after** internal testing succeeds. It is a second, separate grant.
TestFlight and App Store releases need it, plus a newly signed build. Asking
early spends a review cycle on a build that was never going to ship.

---

## 2. 🔴 The EAS trap — why the cloud build could not work

An EAS profile named `taptopay-device` was tried first and could not succeed,
for a reason that no amount of credential refreshing fixes:

- the profile inherited **internal / ad-hoc distribution** signing;
- Apple had granted the **development** entitlement only;
- so Apple generated an **ad-hoc profile without the Tap-to-Pay entitlement**;
- refreshing that same profile could not help, because the mismatch is the
  **profile type**, not a stale profile.

A development entitlement needs a **development** profile. That is what the
local Xcode route below produces, and it is why that route is the documented one
for internal testing.

---

## 3. The proven local Xcode development build

Run from a clone **outside iCloud** (`~/dev/CutsCentral`, not Desktop).

```bash
cd apps/mobile

# 1. Arm the flag locally. .env.local is gitignored - never commit it.
printf 'TAP_TO_PAY_NATIVE_ENABLED=true\n' > .env.local
git check-ignore .env.local        # must print the path

# 2. Install
pnpm install --frozen-lockfile

# 3. 🔴 UTF-8 FIRST, or CocoaPods dies on
#    "Unicode Normalization not appropriate for ASCII-8BIT"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# 4. Clean prebuild (regenerates ios/ and runs pod install)
npx expo prebuild --platform ios --clean

# 5. Open the WORKSPACE, never the .xcodeproj (the project alone has no Pods)
open ios/ChairBackRewards.xcworkspace
```

Then in Xcode:

1. Select the **ChairBackRewards target** (not the project row above it).
2. **Signing & Capabilities** → tick **Automatically manage signing**.
3. **Team → ZLP9T7HSYJ**.
   🔴 `prebuild --clean` regenerates `ios/` from scratch and **resets signing**,
   so the team must be selected again after *every* prebuild. Skipping this
   fails with *"Signing for ChairBackRewards requires a development team."*
   That is not a code error and nothing in the repo needs changing.
4. Confirm **Tap to Pay on iPhone** appears in the capability list. It will not
   render until the team is set. If it is still absent after that, the
   capability is not enabled on the App ID — fix at developer.apple.com.
5. **Product → Scheme → Edit Scheme → Run → Build Configuration: Release.**
   Release gives a standalone install that runs without Metro attached.
6. Select the **registered physical iPhone** and press **Run**.

`ios/`, `Pods/` and `.env.local` are all generated or ignored. None of them
belong in a commit.

---

## 4. Verifying the build — against the SIGNED app

The entitlements **source file** only states intent. Verify the signed binary.

```bash
APP="$(ls -d ~/Library/Developer/Xcode/DerivedData/ChairBackRewards-*/Build/Products/Release-iphoneos/ChairBackRewards.app | head -1)"

# Raw XML - shows the key and its value
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -A1 "proximity-reader"

# Or read it properly with PlistBuddy
codesign -d --entitlements :- "$APP" 2>/dev/null > /tmp/ent.plist
/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.proximity-reader.payment.acceptance' /tmp/ent.plist
```

🔴 **Do NOT use `plutil -extract` for this key.** `plutil` treats dots as
**nested path separators**, so
`plutil -extract com.apple.developer.proximity-reader.payment.acceptance` goes
looking for a key `com` containing `apple` containing `developer`… finds
nothing, and **returns empty on a binary that does carry the entitlement.** That
false negative was hit and mistaken for a missing entitlement. Use PlistBuddy or
the raw XML above, both of which handle dotted key names literally.

Also confirm the runtime half, which is a separate gate:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['extra']['tapToPayNativeEnabled'])" \
  "$APP/EXConstants.bundle/app.config"

ls "$APP/Frameworks" | grep -i stripe
```

### Verified evidence — 2026-09-22 device build

```
com.apple.developer.proximity-reader.payment.acceptance = true
application-identifier                                  = ZLP9T7HSYJ.com.getchairback.rewards
aps-environment                                         = development
extra.tapToPayNativeEnabled                             = true
StripeTerminal.framework                                  present in the app bundle
```

`aps-environment: development` and `get-task-allow: true` are correct for a
device run; both change in a store archive.

---

## 5. Stripe: platform and connected account

- **Platform:** Tap to Pay enabled on the ChairBack platform account, under
  Terminal in the Stripe dashboard.
- **Connected account:** each barber's account must accept Stripe's Tap to Pay
  terms. The code passes `tosAcceptancePermitted: true` so a barber can accept
  on the device rather than being refused with nothing to do about it — but the
  platform must permit that first.

**Terminal Locations** are created lazily per shop on the first connection-token
request and cached on `Shop.stripeTerminalLocationId`.

SDK version is `0.0.1-beta.33` — the only React Native Terminal SDK Stripe
publishes. The beta string is Stripe's, not a sign we picked something
unfinished.

## 6. Device requirements

iPhone XS or later, iOS 16.4 or later, registered to the team. **A simulator has
no NFC hardware and cannot take a payment.** The barber must be signed in to the
app in barber mode.

---

## 7. The release check — still not met

**Tap to Pay is not "working" until a real, low-dollar payment has gone through
on a physical supported iPhone and the Stripe PaymentIntent, the signed webhook,
the ChairBack attempt/payment ledger and the connected account all agree.**

Nothing short of that counts — not a green suite, not a successful build, not a
reader connecting, and not the verified entitlement above.

The next run, in order:

1. Make an **isolated Stripe test connected account** Terminal-ready.
2. Accept the Tap-to-Pay / Terminal terms on it.
3. Configure its **Terminal Location**.
4. Enable checkout **only for that isolated test shop**.
5. Process **and refund $1.00** on this iPhone.
6. Confirm the PaymentIntent, the signed webhook, the ChairBack ledger and the
   connected account all match.

The full script is in `docs/service-checkout.md` under "The real-iPhone test
script".

Only after that succeeds: request Apple's **distribution** entitlement, then
produce a **new** TestFlight build. Build 43 cannot be used — it was built with
the flag off and carries no entitlement.

Until this is ticked the surface stays dark: `SERVICE_CHECKOUT_ENABLED` is
false, and even with it on a device that announces no capability shows "Not set
up on this device yet".

---

## Merchant education — required, and already built

> **Apple requires you to present a "How to Tap" instructional overlay when
> enabling Tap to Pay on iPhone. You must integrate this before submitting your
> app for review.** — Stripe, *Tap to Pay on iPhone*

An app without it fails App Review, and the Stripe Terminal React Native SDK
does **not** expose the API, which is why
`apps/mobile/modules/tap-to-pay-education/` exists.

- **iOS 18+**: Apple's `ProximityReaderDiscovery`,
  `content(for: .payment(.howToTap))` then `presentContent(_:from:)`, presented
  from the **topmost** presented view controller — Stripe notes the call fails
  otherwise, and this app's WebView routinely sits under a sheet.
- **iOS 17 and earlier**: a native fallback screen of our own.
