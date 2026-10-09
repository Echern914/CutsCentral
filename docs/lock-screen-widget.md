# The Lock Screen widget ("Next up")

A barber's next client on the iPhone Lock Screen: **NEXT · 2:30 PM / Sam / Fade**.
It flips to the next client 10 minutes after each start (a late client is still
"next"), and taps through to that booking in the app.

**It is off in every build until it has been built and looked at on a real
iPhone.** Nothing in `apps/mobile/targets/next-up/` could be compiled where it
was written.

## How it works

| Piece | Where |
|---|---|
| Who's next, using the same rule as the Next up push (his own chair; the owner also gets chairs nobody is linked to) | `GET /api/next-up` (`apps/api/src/routes/nextUp.ts`) |
| A token that can read that one route and nothing else, and dies at sign-out | `POST /api/next-up/token`, `apps/api/src/auth/widgetToken.ts` |
| "Client names on the lock screen" (on by default) | Account → Notifications, shown only inside an app build with the widget |
| The app writes a snapshot and the token into the shared App Group | `apps/mobile/src/nextUpWidget.ts`, called from `app/barber.tsx` |
| The widget: shows the snapshot, refreshes itself about every 30 min with the token, and forgets everything on a 401 | `apps/mobile/targets/next-up/NextUpWidget.swift` |

Why a separate token: the widget runs while the phone is locked, and the app's
session sits in the keychain as "when unlocked, this device only" on purpose,
because it is the whole account. The widget token can only read the next few
appointments. Sign out, Sign out everywhere and a password reset all kill it.

## Turning it on (on the Mac)

Everything in `docs/mobile-release-xcode.md` still applies. In addition:

1. **App Group.** In the Apple Developer account (team ZLP9T7HSYJ), make sure the
   App Group `group.com.getchairback.rewards` exists. Xcode's automatic signing
   usually creates it the first time it signs a target that asks for it. If it
   asks, let it.
2. **Prebuild with the flag:**

   ```bash
   cd ~/dev/CutsCentral/apps/mobile
   NEXT_UP_WIDGET_ENABLED=true npx expo prebuild --platform ios --clean
   open ios/ChairBackRewards.xcworkspace
   ```

   The project gains a second target, **NextUp** (the widget extension). Its
   files appear under `expo:targets/next-up`. Edit them there, never in `ios/`.
3. **Signing:** select the NextUp target → Signing & Capabilities → team
   ZLP9T7HSYJ, automatic. It must show the App Group capability with
   `group.com.getchairback.rewards`, and so must the app target.
4. Build and run on the iPhone. Then **long-press the Lock Screen → Customize →
   Lock Screen → add a widget → ChairBack → Next up**.

The flag has to be set for **every** build that should carry the widget,
including the App Store build. Without it, prebuild leaves the widget out
entirely, and the app neither writes widget data nor offers the names setting.

## Checks on the iPhone (none have been done yet)

1. **Shows the next client:** with a booking later today, the widget shows the
   time, first name and service, and it matches the dashboard.
2. **Flips on its own:** it moves to the following client 10 minutes after
   each start, with the app closed.
3. **New bookings appear:** book someone in from another device. Within about
   30 minutes, without opening the app, the widget shows them. Opening the app
   updates it at once.
4. **Names off:** turn off Account → Notifications → "Client names on the lock
   screen", then open the app. The widget shows time and service only.
5. **Sign out:** the widget says "Signed out" (immediately if the app saw the
   sign-out, otherwise at its next refresh) and shows no client.
6. **Owner, unlinked chair:** an owner whose chair isn't linked to a barber
   sees those bookings, the same as their Next up alerts.
7. **Tap:** tapping the widget opens the app on that booking.
8. **iOS 16 and 17 or later:** the widget renders (17 needs the container
   background, which is handled).
9. **Default build:** a build made **without** the flag has no widget target
   and no App Group, and signs exactly as before.
