# What's New — 1.0.5 (build 35)

Previous release: **1.0.4 = build 34, cut from `6c9d03d`** (2026-08-10).
This release: everything merged to `main` after that commit.

## Paste into App Store Connect → "What's New in This Version"

```
Switching sides no longer means signing out. If you cut hair and also collect your own rewards, you can move between your dashboard and your rewards card whenever you like.

Signing in is less of a dead end too — if we can't find an account for your Apple or Google address, the app now tells you how to get in instead of stopping there.

Also new since the last release:

• Chair-side checkout — finish a cut and record what you actually took, cash or card
• Walk-ins in one tap — no name, no signup, just what they paid
• A Day view for your calendar, beside the month
• Reschedule a booking properly, instead of cancelling and rebooking it
• A QR code for your shop that sends clients straight to your booking page
• Choose black & gold or white & gold, and switch any time in Account
• Your booking page can show your Instagram and your Google reviews
• Faster, steadier loading across the app
```

## Honesty note for whoever ships this

Only the **first two** items are changes to the app binary
(`1bf9649` mode switching, `9ab1409` sign-in recovery). Everything under "Also
new" is web, and reaches users through the WebView **without** an app update —
someone still on build 34 already has it.

That is fine to list: from a user's point of view these genuinely are new in
ChairBack, and release notes describe the product, not the delivery mechanism.
It would NOT be fine to describe them as fixes to the app itself, which is why
the copy above never says "we fixed" about any of them.

## The 17 commits in this release

Binary:
- `1bf9649` feat(mobile): switch between barber and customer
- `9ab1409` fix(app): "no account yet" stops dead-ending new sign-ups

Web / API (visible in the app's WebView):
- `debfce8` per-shop "Scan to book" QR code
- `9ee5105` one-tap nameless walk-ins
- `d4d1496` Square sync parity with Acuity (self-healing resync)
- `72e865e` calendar Day view + shorter Chair time ranges
- `5df6a21` Tap to Pay groundwork (server half)
- `9478484` chair-side checkout
- `e63a2db` durations roll into days; blocked time stops repeating
- `93142d5` booking confirmations by email only (cost)
- `eb9e86d` light/dark theme
- `97eb52a` client picker shows names, not phone numbers
- `016dfc9` pinned the reminder-sweep clock (test stability)
- `fc1ccdf` Railway build fix + barber can unblock time
- `3499ae5` Instagram, real last names, Google reviews, rebook nudge
- `e62b496` barber can move a booking
- `4cdce1b` Manage reschedules in one tap
