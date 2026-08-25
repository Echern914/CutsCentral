# App Review notes: "Join your shop"

Paste-ready notes for App Store Connect, plus the setup this flow needs before
it can go live. Everything here describes the invited-EMPLOYEE path only; the
paid shop-owner signup is untouched and still lives on the web.

## For the "Notes" field in App Store Connect

> **Join your shop** opens ChairBack's secure account-authentication page for an
> employee who has already been invited by a barbershop. No purchase or
> subscription is offered in this flow. After authentication and invitation
> acceptance, the user returns to the app to access the inviting organization's
> existing account.

Add underneath:

> The page opens in the system authentication browser
> (ASWebAuthenticationSession), not an embedded web view, because Google blocks
> OAuth in embedded web views and because the employee's password or Apple ID
> must never be typed into our app's process. The app receives a one-time
> authorization code, not a session token, and exchanges it for a session over
> HTTPS.
>
> Employee accounts are free. Account deletion is available in the app under
> Account (Guideline 5.1.1(v)).

## Demo credentials to supply

Two things, both of which must exist before submitting:

1. **Demo account** — the existing App Review demo account (email + password,
   already in App Store Connect). It signs in on the first screen and does not
   touch this flow.
2. **A live test invitation** for the reviewer. Generate it right before
   submitting, because invitations expire after seven days:
   - sign in as the demo shop owner on getchairback.com,
   - Dashboard → Team → Invite, role **Barber**, using an address the reviewer
     can receive at (or an address you control, then paste the link),
   - copy the `https://getchairback.com/team/join?token=…` link out of the
     email and put it in the review notes,
   - tell the reviewer the invited email address, since acceptance requires
     signing in as that address (this is a deliberate anti-forwarding rule).

Reviewer steps: open the app → **Join your shop** → paste the invitation link →
Continue → create the account or sign in in the browser sheet → the app returns
to the barber calendar signed in.

## What is deliberately NOT in this flow

Checked against the reasons a build has been rejected before:

- no plan prices anywhere on the screen or on the pages it opens;
- no subscription checkout, and no link to one;
- no "avoid Apple fees" or external-purchase messaging;
- no feature is unlocked by a purchase during the flow;
- no shop/business is CREATED - the shop already exists, and the employee is
  joining it. `signupAction` sends an invited barber to their invitation, never
  to the shop-creation wizard (`/onboarding`).

Shop-owner signup (the paid path) stays where it is: on the web, opened in
Safari by the app shell, with the in-app signup card replaced by a neutral
notice. This PR adds no owner subscription link to the iOS app.

## Setup required before this works in production

### 1. Apple (only needed for "Continue with Apple" on the WEB)

The web Apple button is dark until all five are set on the API (Railway).
Without them nothing breaks - the button simply does not render, and email +
Google still work.

| Variable | Where it comes from |
| --- | --- |
| `APPLE_OAUTH_SERVICES_ID` | Developer portal → Identifiers → **Services IDs** → the identifier (NOT the app's bundle id) |
| `APPLE_OAUTH_TEAM_ID` | Membership page (10 characters) |
| `APPLE_OAUTH_KEY_ID` | Keys → the "Sign in with Apple" key's id |
| `APPLE_OAUTH_PRIVATE_KEY` | the downloaded `AuthKey_XXXX.p8` contents (newlines may be `\n`; the code normalizes them) |
| `APPLE_OAUTH_REDIRECT_URI` | `https://api.getchairback.com/api/auth/apple/callback` |

In the Services ID configuration, add domain `getchairback.com` and return URL
`https://api.getchairback.com/api/auth/apple/callback`. Apple posts the callback
as a cross-site form POST, which is why our state is signed rather than
cookie-compared.

### 2. Android app links (optional, no Android build today)

`/.well-known/assetlinks.json` serves an empty array until
`ANDROID_CERT_SHA256_FINGERPRINT` is set on Vercel. Leave it unset until an
Android build exists: publishing a WRONG fingerprint makes Android cache a
failed verification. Get the real one from `eas credentials` or Play App
Signing, then set it (comma-separated if there is more than one).

### 3. A new native build

`expo-web-browser` and `expo-secure-store` are config plugins, so the flow needs
a fresh EAS build - it cannot ship as an OTA update. Also note that iOS caches
the apple-app-site-association file: ship the web deploy (which adds
`/team/join*` and `/auth/mobile/callback*`) BEFORE the app build that relies on
them, and don't expect existing installs to pick up the new paths immediately.

## The security shape, in one paragraph

The callback URL carries a two-minute, single-use authorization code and the
app's own `state` - never a session, refresh, or access token. Redeeming it
requires the PKCE verifier, which never leaves the device, and the same state
the app generated; the code is stored only as a sha256 and is claimed by a
compare-and-set, so a replay (or a code observed in the redirect) buys nothing.
The invitation token is redacted from request logs and from analytics URLs, and
every page that carries one sends `Referrer-Policy: no-referrer`. Acceptance
still requires being signed in as the invited address.
