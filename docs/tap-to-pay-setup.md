# Tap to Pay on iPhone — the setup that cannot be done in code

Everything in this file is an account, an approval or a device. None of it can
be written, tested or worked around by changing the repository, which is why it
is a separate document from `service-checkout.md`: the code is on a branch and
reviewable today, and **none of it can be proven until the items below are
done.**

Read this as a checklist to work through in order. Steps 1–3 gate everything
else, and step 1 is the long pole because Apple decides the timing.

---

## What is already built

| | where | proven? |
|---|---|---|
| Card-present PaymentIntents, destination charges, the exact fee | `apps/api/src/billing/terminal.ts` | against a fake Stripe only |
| Attempt ledger, the live lock, settlement | `apps/api/src/routes/booking.checkout.ts` | against a fake Stripe only |
| Connection tokens + per-shop Terminal Location | `apps/api/src/routes/payments.dashboard.ts` | never called by a real reader |
| Native SDK integration, the page↔shell bridge | `apps/mobile/src/tapToPay/` | **never run on a device** |
| The entitlement, behind a default-off flag | `apps/mobile/app.config.ts` | both generated configs tested; **never signed with it on** |

---

## 0. The flag: `TAP_TO_PAY_NATIVE_ENABLED`

**Nothing in this file changes how the app builds today.** Tap to Pay's native
half is behind a build-time flag that **defaults to false**, so an ordinary
build signs and ships exactly as it did before this landed — no entitlement, no
location permission string, and the shell tells the dashboard nothing, so the
checkout screen reads "Not set up on this device yet".

```bash
# The default. Signs normally. Tap to Pay is not offered.
eas build --platform ios

# Only once Apple has granted the entitlement (step 1).
TAP_TO_PAY_NATIVE_ENABLED=true eas build --platform ios
```

Accepted as on: `true`, `1`, any casing, surrounding spaces. **Anything else —
including a typo like `yes` or `on` — reads as off**, because a mistyped build
script must not be what puts an ungranted entitlement into a binary.

🔴 **One flag, three consequences, deliberately inseparable.** Setting it true
adds the entitlement, adds the Stripe Terminal config plugin (the Info.plist
permission strings), *and* tells the JS bundle it may announce the capability.
They are one decision because a binary that advertises Tap to Pay without the
entitlement hands the barber a button that dies at the reader with a customer
standing in front of them. `apps/mobile/src/tapToPay/appConfig.test.ts` asserts
both generated configurations and that these three can never disagree.

---

## The order these must happen in

**🔴 THERE ARE TWO ENTITLEMENTS, NOT ONE**, and Stripe's documentation is
explicit about the sequence: "you must first request and configure the Tap to
Pay on iPhone **development** entitlement from your Apple Developer account.
After you complete internal testing, you must request a **distribution**
entitlement."

Doing them out of order wastes an Apple review cycle. The whole path:

| # | step | who | gate it opens |
|---|---|---|---|
| 1 | **Development** entitlement requested and granted | Eric | internal testing on a physical device |
| 2 | **Development** provisioning profile regenerated *after* the grant | Eric | a build that signs with the entitlement |
| 3 | EAS **development/internal** build on a **registered** physical iPhone, `TAP_TO_PAY_NATIVE_ENABLED=true` | Eric + us | a real reader on a real device |
| 4 | **A real $1.00 payment and refund**, with the Stripe intent, the signed webhook, the ChairBack attempt/payment ledger and the connected account all agreeing | Eric | the only thing that makes "it works" true |
| 5 | **Distribution** entitlement requested and granted | Eric | a shippable build |
| 6 | **Distribution** provisioning refreshed | Eric | signing a release build |
| 7 | Production / TestFlight build, then App Review submission | Eric + us | customers |

Nothing between 1 and 4 is shippable, and **step 4 is not a formality** — see
the bottom of this file.

---

## 1. Apple: the DEVELOPMENT entitlement

**What:** `com.apple.developer.proximity-reader.payment.acceptance`, granted per
bundle id — ours is `com.getchairback.rewards`.

**How:** request it from the Apple Developer account that owns the app, through
the Tap to Pay on iPhone request form. Apple reviews it; this is not a checkbox
that takes effect immediately.

**🔴 A build carrying the entitlement fails to sign until it is granted.** That
is why the flag above exists and why it defaults off: with the default, this
wall is simply not in the way, and no release is blocked waiting on Apple. Turn
the flag on only after the grant lands.

**Apple takes no cut.** The entitlement is permission to use the NFC hardware.
A haircut is a real-world service and is expressly excluded from in-app
purchase, so these payments go card → Stripe → the barber, with no App Store
commission.

## 1b. Apple: the DISTRIBUTION entitlement — later, not now

Requested **after** internal testing is done (step 4 above). Asking for it
before there is anything to distribute is how a review cycle gets spent on a
build that was never going to ship.

## 2. Apple: provisioning

Once granted, the provisioning profile must be **regenerated** — an existing
profile does not gain the entitlement retroactively — and EAS credentials
refreshed so the build picks up the new profile.

Development provisioning comes first, for step 3. Distribution provisioning is
refreshed separately after the distribution entitlement lands (step 6): they are
different profiles and the second does not follow from the first.

## 2b. 🔴 NO DEVICE IS REGISTERED, and that blocks the device build

`eas device:list --apple-team-id ZLP9T7HSYJ` returns **"Could not find devices
on Apple team"**. An internal / ad-hoc build for a physical iPhone cannot be
produced until at least one device UDID is registered, whatever else is in
place. See "What Eric has to do" at the bottom.

A **simulator** build needs none of this — no entitlement, no provisioning, no
device — and is what the `simulator` profile in `eas.json` exists for. It
proves the Swift module and the Stripe Terminal SDK compile and link; it cannot
prove anything about taking a payment, because a simulator has no NFC hardware.

## 3. Stripe: Tap to Pay on the platform, terms on the connected account

Two separate things, and both are required:

- **Platform:** Tap to Pay enabled on the ChairBack platform account, in the
  Stripe dashboard under Terminal.
- **Connected account:** each barber's account must accept Stripe's Tap to Pay
  terms. The code passes `tosAcceptancePermitted: true` when connecting, so a
  barber can accept on the device the first time rather than being refused with
  nothing to do about it — but the platform must permit that first.

**Terminal Locations** need nothing: one is created lazily per shop on the first
connection-token request and cached on `Shop.stripeTerminalLocationId`.

## 4. Device

- iPhone XS or later, iOS 16.4 or later.
- **A simulator cannot take a real payment.** There is no way to fake this step.
- The barber must be signed in to the app in barber mode.

## 5. Build

A native build **with the flag on** — `TAP_TO_PAY_NATIVE_ENABLED=true` — since
`@stripe/stripe-terminal-react-native` is a config plugin and a native module,
so **it does nothing in an OTA update.** EAS build, then TestFlight.

Check the build actually carries it before testing on a device: the generated
`ios/` project should contain the entitlement, and
`Constants.expoConfig.extra.tapToPayNativeEnabled` should be `true` in the
running app. If the flag was missed, the app behaves exactly like the default
build — Tap to Pay simply is not offered — which looks identical to a device
that cannot do it.

Note the SDK version: `0.0.1-beta.33`. That is the only React Native SDK Stripe
publishes for Terminal, and the beta version string is Stripe's, not a signal
that we picked something unfinished.

---

## 6. The release check that has not been met

**Tap to Pay is not "working" until a real, low-dollar payment has gone through
on a physical supported iPhone and the webhook, the ChairBack ledger and the
connected Stripe account all agree.**

Nothing short of that counts — not a green test suite, not a successful build,
not a reader connecting. The exact script to run is in
`docs/service-checkout.md` under "The real-iPhone test script". Run it on a real
shop's own connected account with a **$1.00** ticket, and refund it afterwards.

Until that is ticked, the surface stays dark: `SERVICE_CHECKOUT_ENABLED` is
false, and even with it on, a device that announces no capability shows
"Not set up on this device yet".

---

---

## Merchant education — required, and already built

> **Apple requires you to present a "How to Tap" instructional overlay when
> enabling Tap to Pay on iPhone. You must integrate this before submitting your
> app for review.** — Stripe, *Tap to Pay on iPhone*

This is not advice. An app without it fails App Review, and the Stripe Terminal
React Native SDK does **not** expose the API, which is why
`apps/mobile/modules/tap-to-pay-education/` exists.

- **iOS 18+**: Apple's own `ProximityReaderDiscovery`, `content(for:
  .payment(.howToTap))` then `presentContent(_:from:)`, presented from the
  **topmost** presented view controller (Stripe notes the call fails otherwise,
  and this app's WebView routinely sits under a sheet).
- **iOS 17 and earlier**: a native fallback screen of our own. It is a
  **fallback**, never a substitute — Apple's content is localized for the
  merchant's region and kept current by Apple.
- **When**: the first time a barber *chooses* Tap to Pay, per device. Not during
  a collection: Apple's overlay has no dismissal callback, so showing it then
  would drop an instructional sheet on top of a live payment.
- **🔴 If it cannot be shown on iOS 18+, Tap to Pay is refused** rather than
  falling back. Shipping around the requirement quietly is how an app arrives at
  review without the thing Apple asked for and nothing anywhere saying so.

---

## What Eric has to do

Everything below needs an Apple account, a Stripe dashboard or a physical
phone. None of it can be done from the repository.

**1. Register a device** — blocks the physical-device build today.

```
cd apps/mobile
npx eas device:create
```

Choose *Website* or *Developer Portal*, open the link on the iPhone that will
take payments, install the profile, then confirm it appears in
`npx eas device:list --apple-team-id ZLP9T7HSYJ`.

**2. Request the Tap to Pay DEVELOPMENT entitlement**

https://developer.apple.com/contact/request/tap-to-pay-on-iphone/

Bundle ID `com.getchairback.rewards`, Team ID `ZLP9T7HSYJ`. Apple replies by
email; it is a review, not a toggle.

**3. Enable Tap to Pay on the Stripe platform account**

Stripe Dashboard → **Terminal** → **Tap to Pay**, on the ChairBack **platform**
account (not a connected account). The connected account accepts Stripe's Tap
to Pay terms on the device the first time — the code passes
`tosAcceptancePermitted: true` so that is possible — but the platform must
permit it first.

**4. After the grant**: regenerate development provisioning, then

```
cd apps/mobile
npx eas build --platform ios --profile taptopay-device
```

That profile sets `TAP_TO_PAY_NATIVE_ENABLED=true`. Every other profile leaves
it false.

**5. The $1 test** — the real-device script in `docs/service-checkout.md`.

---

## What to do if the entitlement is refused or delayed

**Nothing.** That is the whole point of the default. Leave
`TAP_TO_PAY_NATIVE_ENABLED` unset and the app builds, signs and ships as it
always has, with the Tap to Pay option reading "Not set up on this device yet".
No code needs editing and no block needs commenting out.

The rest of checkout is unaffected either way — saved card and cash never touch
any of this, and the server half is inert without a client that can reach it.
