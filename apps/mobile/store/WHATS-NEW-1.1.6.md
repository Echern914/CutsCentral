# What's New — 1.1.6 (build 51)

Previous release: **1.1.5 = build 50**. Build 51 was cut on 2026-10-11 and
**never uploaded** (Eric, 2026-10-17), so it keeps its number and now also
carries white & gold and the Lock Screen widget.

## Paste into App Store Connect → "What's New in This Version"

```
A brighter ChairBack: the app is now white and gold to match the site. Prefer the original black and gold? Switch back anytime in Account → Appearance.

New Lock Screen widget: add "Next up" to see your next client and their service at a glance.

Read your client's note before they walk in. Notes now show in your notifications and in your Next up alert.

Setting up is quicker: paste your service menu from your old booking app, and ask the Assistant what's left to set up.

Signing out of your dashboard now signs out the app too, and a signed-out phone stops getting notifications.

Fixes: one tap opens one screen so Back works the first time, notifications keep trying until they're registered, and join links show the right shop.
```

## Honesty note for whoever ships this

| What | In the binary? | Notes |
|---|---|---|
| White & gold screens, splash, status bar | ✅ this build | the web pages inside were already light |
| Lock Screen widget | ✅ only if prebuilt with `NEXT_UP_WIDGET_ENABLED=true` | 🔴 drop its paragraph from the notes if the widget is left out |
| Client notes, paste your menu, the Assistant | web, already live | shown inside the app; they read as new to an app user |
| Sign-out reaches the app, pushes stop (#636); one tap = one screen (#634); push registration retries, Tap to Pay reader reuse, timers (#615); Home/Clients/Team (#606) | ✅ this build | merged after build 50 |

No prices, no plans, no purchase CTAs, no competitor names (same rules as
`LISTING.md`).

## App Review notes (paste if asked what changed)

```
This update refreshes the app's look to white and gold, adds an optional Lock Screen widget that shows the signed-in barber's next appointment (time, first name and service; names can be hidden in Account → Notifications), and fixes sign-out and notification registration. The widget reads only the signed-in barber's next appointments, using a token that ends at sign-out. No new permissions are requested.
```
