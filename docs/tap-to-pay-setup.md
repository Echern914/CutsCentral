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
| The entitlement declaration | `apps/mobile/app.config.ts` | **never signed** |

---

## 1. Apple: the entitlement

**What:** `com.apple.developer.proximity-reader.payment.acceptance`, granted per
bundle id — ours is `com.getchairback.rewards`.

**How:** request it from the Apple Developer account that owns the app, through
the Tap to Pay on iPhone request form. Apple reviews it; this is not a checkbox
that takes effect immediately.

**🔴 Until it is granted, a build carrying the entitlement will fail to sign.**
The declaration is already in `app.config.ts`, so the first build attempt after
merging this branch will fail if the entitlement is not yet on the account. That
is deliberate — a silent fallback would ship a button that cannot work — but it
means **do not merge this to a release branch while a build is due out**, or
comment the `entitlements` block out until the grant arrives.

**Apple takes no cut.** The entitlement is permission to use the NFC hardware.
A haircut is a real-world service and is expressly excluded from in-app
purchase, so these payments go card → Stripe → the barber, with no App Store
commission.

## 2. Apple: provisioning

Once granted, the provisioning profile must be **regenerated** — an existing
profile does not gain the entitlement retroactively — and EAS credentials
refreshed so the build picks up the new profile.

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

A native build — `@stripe/stripe-terminal-react-native` is a config plugin and
a native module, so **it does nothing in an OTA update.** EAS build, then
TestFlight.

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

## What to do if the entitlement is refused or delayed

The rest of checkout is unaffected — saved card and cash do not touch any of
this. Remove the `entitlements` block from `app.config.ts` and the Stripe
Terminal plugin entry, and the app builds and ships exactly as it does today
with the Tap to Pay option reading "Not set up on this device yet". The server
half is inert without a client that can reach it.
