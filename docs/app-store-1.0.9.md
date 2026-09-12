# App Store copy — 1.0.9 (build 41)

Paste-ready text for App Store Connect. Built 2026-09-12 from
`feat/local-xcode-builds` @ `5a309cd` (on top of main `ecfb8fb`), the first
build made locally in Xcode. Archive kept at
`~/dev/ChairBackRewards-1.0.9-41.xcarchive`.

## What's New in This Version

Meet My ChairBack — your own home in the app.

Sign in once with a code sent to your phone or email and everything you do with
your shops is in one place: your next appointment right at the top, every shop
you visit, your rewards at each one, and your visit history. Tap a shop to book;
tap an appointment to get directions, reschedule, or cancel.

• Next up first — day, time, how far away it is, who's cutting, and where
• Your shops in one list, with Book one tap away
• Rewards per shop and per card — "3 more visits until $10 off"
• Appointments, upcoming and past, whether you booked here or through the shop
• Appointment status that tells the truth: Requested, Booked, Completed, or
  Canceled — and who you're waiting on when it's still a request
• A new opening when you launch the app

Prefer the old way? Every shop's page and booking flow still work exactly as
before, and a link from your shop still opens straight to it.

## Promotional Text (170 characters max)

Your shops, your next appointment, and your rewards — all in one place. Sign in
once with a code and My ChairBack keeps track of every visit for you.

## Notes for App Review

**Customer side (My ChairBack, new in this version):** on first launch choose
"I'm a customer". On the sign-in screen tap **"Just looking? Try the demo"** —
no phone number or email is needed. This opens a read-only demo account on our
seeded demo shop with appointments, rewards and visit history, and all five tabs
(Home · Book · Appointments · Rewards · Profile).

🔴 **Prerequisite — the reviewer will see "not switched on yet" unless
`CUSTOMER_ACCOUNTS_ENABLED=true` is set on the API (Railway) before
submitting.** The entire customer-account API, the demo route included, answers
404 while that flag is off. Submitting with it off is a guaranteed 2.1 "does not
function as described" rejection.

**Business side:** unchanged from 1.0.8; the existing demo business credentials
in the App Review notes still apply.

**Nothing in this version records or shares the reviewer's data:** the demo
session is read-only and expires after two hours.

## What is and isn't in build 41

| Change | Where it ships | In build 41? |
|---|---|---|
| My ChairBack — customer home, sign-in, tabs (#417) | native app | **Yes** |
| Opening animation | native app | **Yes** (this branch) |
| Honest appointment status words on the manage page (#414) | web page the app opens | Yes — live on the web already |
| My ChairBack accounts API (#415) | API, dark behind `CUSTOMER_ACCOUNTS_ENABLED` | n/a — flip the flag |
| Client broadcasts / email or notification blasts (#413) | business dashboard, web + API | Live on the web; not an app feature |
| Punch ledger integrity (#416), duplicate-client review (#418) | business dashboard, web + API | Live on the web; not an app feature |
| Build from Xcode, build-number handoff, fmt plugin retired | build tooling, this branch | Yes |

🔴 **`feat/local-xcode-builds` is not merged.** Build 41 was made from it. If
the next build is cut from `main` without merging it, the opening animation, the
build-number handoff (`buildNumber` in `app.config.ts`) and the retired fmt
plugin all silently revert. Merge it before the next release.

## Known-benign warnings at upload

"Upload Symbols Failed — no dSYM for React.framework / ReactNativeDependencies.framework / hermes.framework".
Prebuilt frameworks in React Native 0.81; every upload shows them. Ignore.
