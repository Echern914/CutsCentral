# What's New — 1.0.9 (build 42)

Previous upload: **1.0.9 = build 41**, the first build cut locally in Xcode
(`docs/mobile-release-xcode.md`), carrying My ChairBack (#417) and the animated
launch. Build 40 was archived from a tree that predated #417 and almost
certainly never reached App Store Connect — if a "40" ever appears in
TestFlight, do not release it to testers.

Build 42 is the same **1.0.9**. The version string only has to change once a
version has been **submitted for review** — that is the wall build 37 hit
(`SUBMISSION_SERVICE_IOS_OLD_APP_VERSION`). TestFlight accepts any build number
App Store Connect has not already seen, so 1.0.9 / 42 is correct here. If 1.0.9
has since been submitted for review, bump to 1.1.0 before uploading.

## Paste into App Store Connect → "What's New in This Version"

```
My ChairBack is now yours, not one shop's: your next appointment, the shops you go to, and your standing at each one, all on your own home screen. Add a shop to your account when you find it and it stays there. Your first and last name travel with you, so the shop knows who is in the chair. Where a shop runs a loyalty tier you can see the tier you are in and exactly what the next one takes, and when your shop opens a time for your tier you get it first — a notification, then a tap to book it before it goes to everyone.
```

## Honesty note for whoever ships this

Every line above is a change to the **app binary**, which is unusual: all four
merges in this window touch `apps/mobile`.

| Merge | What the app itself gained |
|---|---|
| #423 | first + last name in My ChairBack, and the name the barber sees |
| #424 | "Add to my shops" from search, and the saved-shops list |
| #426 | the tier card, its progress bar, and the profile it lives on |
| #427 | tier-held openings: the notification, the list, and claiming one |

So a build-41 device does **not** have any of it — the WebView only ever
carries the web half of a feature. That is precisely why this build exists.

No prices, no plans, no purchase CTAs, no "free payments", no competitor
mentions — the same rules as the listing (see `LISTING.md`).

## Before archiving

- `apps/mobile/app.config.ts` says `version: "1.0.9"`, `buildNumber: "42"`.
  The number Apple sees now lives in this file (`eas.json` is
  `appVersionSource: "local"`); bump it by hand for every upload.
- Build from a commit that is **on `main`**, never a branch tip, or the build
  cannot be resolved back to what is in it
  ([[chairback-testflight-build-provenance]] exists because of that trap).
- The runbook is `docs/mobile-release-xcode.md`, starting with the check that
  matters most: bundle id `com.getchairback.rewards`, App Store Connect app
  `6783995804`.
