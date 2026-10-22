# Admin two-step sign-in

The admin portal (`/admin`) opens only after a second check on top of your
password:

- **Authenticator app** (the main way): a 6-digit code from **Authy** (what we
  use), or Google Authenticator, 1Password, or any app that scans a standard
  authenticator QR code. Authy keeps an encrypted backup of its accounts, which
  helps if the phone is lost; set an Authy backup password when it offers one.
- **Emailed code** (the fallback): a 6-digit code sent to your login email. It
  works for 10 minutes, allows 5 tries, and at most 5 codes go out an hour.

A pass lasts **12 hours** on the device that earned it. Every pass emails you
("ChairBack admin was opened"), so a sign-in that wasn't yours shows up in your
inbox.

## First time

1. Open `/admin`. With no app set up yet, it offers an emailed code.
2. Once you're in, the **Authenticator app** card at the top says *Not set up*.
   Tap **Set up**. In Authy, tap **Add account**, scan the QR code (or enter
   the key shown under it), then type the 6-digit code Authy shows for
   *ChairBack admin*. The card now says *On*.

From then on, admin asks for the app's code. "Don't have your phone? Email me a
code instead" is always there.

## Lost your phone

Use the emailed code, then **Set up again** on the card with your new phone.
The old phone's codes stop working the moment the new setup is confirmed.

## Locked out completely (no phone, and email not arriving)

This is the escape hatch, and it needs access to the Railway API service:

1. Set `ADMIN_STEP_UP_ENABLED=false` and redeploy. Admin now opens with your
   password alone.
2. Sign in and set up your authenticator again.
3. **Remove the variable**, or set it back to `true`, and redeploy. Leaving it
   off leaves the portal one stolen password away.

## Why it is built this way

- **A pass is tied to two things.** It's bound to your session and to a random
  pass token, which the website keeps in an httpOnly cookie. A leaked session
  key can mint sessions, but it can't produce that pass token.
- **Setting up an authenticator needs a pass first.** So a stolen login can't
  enroll its own phone.
- **Secrets are sealed at rest.** The authenticator secret is encrypted with
  `TOKEN_ENCRYPTION_KEY` and moves with it in a key rotation
  (`secret-rotation.md`). Emailed codes are stored only as keyed digests.
