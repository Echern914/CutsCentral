# What's New — 1.0.8 (build 39)

Previous release: **1.0.7 = build 38, cut from `07edef5`** (2026-09-02), which
was submitted to Apple and is in review. 1.0.8 exists because a version string
that has already been submitted cannot take another build — the same wall that
killed build 37. This release: everything merged to `main` after `07edef5`.

🔴 **1.0.7 is in review as this is uploaded.** Uploading 1.0.8 to App Store
Connect does not disturb that review — it lands in TestFlight. 1.0.8 cannot be
submitted for App Store review until 1.0.7 is approved or rejected.

## Paste into App Store Connect → "What's New in This Version"

```
Owners can now connect their Stripe account without leaving the app: the sign-in opens in the system browser and returns you here, connected. For customers, your next appointment now leads your rewards page — how long until it, the exact time, who you are seeing, and the shop's address with directions in one tap. That address now travels with you: it is on your confirmation and reminder emails and on the calendar entry, so you always know where you are going. Booking is clearer too — you are told what happens with payment before you confirm, the time you are holding counts down while you check out, and your booking is only confirmed once the payment has actually cleared.
```

## Honesty note for whoever ships this

Only `fc68c42` (#392) touches `apps/mobile`, so it is the only line above that
is a change to the app binary. Everything else is web and already reaches
build-38 users through the WebView — a customer who opened the app yesterday
already has it. Listing it is fine (release notes describe the product); calling
it a fix to the app would not be, which is why the copy never says "we fixed".

No prices, no plans, no purchase CTAs, no "free payments", no competitor
mentions — the same rules as the listing (see LISTING.md).

🔴 Apple Pay renders on the web and in Safari but **not inside this app's
WebView**: WebKit disables Apple Pay on any page touched by injected JavaScript,
and the shell injects its bridge script. Card payment works normally there. The
copy above therefore does not mention Apple Pay. Making it work in-app means
opening checkout in a clean view — a future binary change, not this one.

🔴 The "Create an account" door (#314) is still in this binary and still opens
the website in the system browser. Round 5 of the July review rejected an in-app
button linking out to registration under 3.1.1. The copy above does not
advertise it; the reviewer notes below describe it truthfully. Whether to hide
it before review remains the owner's call.

## App Review Information → Notes (paste; credentials unchanged, see APP-REVIEW-RESPONSE-2026-07.md)

```
WHAT'S NEW IN 1.0.8: one owner-side change and several customer-side improvements. An owner connecting their payment processor now does so through the system browser, which returns them to the app when it is done. Customers see their next appointment and the shop's address on their rewards page, receive the address in confirmation and reminder emails, and are told before confirming a booking whether the shop takes a deposit or keeps a card on file for missed appointments. Nothing is sold in the app, there are no In-App Purchases, and plans and billing exist only on our website in a web browser.

PAYMENTS: money collected in the app is payment for an in-person haircut at a physical barbershop, handled by our payment processor. It is not digital content and is out of scope for In-App Purchase (Guideline 3.1.3(e) / 3.1.5(a)).

SIGN-IN: The welcome screen is a sign-in selector. "I own a barbershop" and "I manage multiple shops" open a sign-in screen for an existing account (Apple, Google, or email). Use the credentials above, or tap "Explore the demo" for a read-only demo dashboard with a guided tour. "I'm a customer" opens the customer view; tap "Try the demo" for a fully populated demo rewards page, no link needed.

ACCOUNTS: The app contains no registration form and no purchase flow. "Create an account" on the sign-in screen opens our website in the system browser (Safari); the account is created there and the browser returns the person to the app signed in.
```

## What is in this release

Binary (1, touches `apps/mobile`):
- `fc68c42` feat(payments): connect Stripe from inside the app via the system browser (#392)

Web / API (visible in the app's WebView, already live for build-38 users):
- `8db901d` feat(payments): charge the card on file - only when set, and only when it's on them (#397)
- `76d94cd` feat(payments): card on file - keep the card at booking, charge nothing (#396)
- `05d62ac` feat(app): the customer's next appointment, first thing in the app (#395)
- `cf4c3b0` feat(booking): tell the customer where the shop is, and how long until (#394)
- `03b4492` feat(checkout): Apple Pay, and a payment screen that stops guessing (#393)
- `fc68c42` feat(payments): connect Stripe from inside the app via the system browser (#392)
- `cbba220` feat(payments): Standard Stripe accounts only - the Express door is retired (#391)
- `a2049e2` fix(payments): a completed ChairBack booking is not "Managed in Acuity" (#390)
- `5a89392` feat(nav): search and More that never dead-end (#389)
- `6bf7a3a` feat(rewards): a shop sets what each tier takes (#388)
- `7439438` fix(affiliate): the toolkit told every business it cuts hair (#387)
- `19a95f9` fix(nav): owners could not find their own features in More or search (#386)
- `7527fb5` feat(booking): say whether the price already includes a tip (#380)
- `20e0ce1` fix(affiliate): the admin desk 500'd on any shop with an affiliate account (#385)
- `650f534` feat(affiliate): credit execution - a month off becomes a Stripe credit, exactly once (PR 5) (#384)
- `0cc233c` feat(affiliate): the five emails, through the durable outbox (PR 4c) (#383)
- `33c4e39` feat(affiliate): the Affiliates tab, the terms page, and the admin desk (PR 4b) (#382)
- `9b49dcb` feat(affiliate): the API the Affiliates tab needs (PR 4a) (#381)
- `ecb5681` docs(store): a description that reads like prose, and promo text for 1.0.7 (#379)
- `f03951f` docs(mobile): 1.0.7 What's New as a paragraph, plus the App Review notes (#378)
