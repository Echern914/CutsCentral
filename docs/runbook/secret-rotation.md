# Rotating the API's secrets

How to replace every secret the API holds without disconnecting a shop,
detaching a customer, or 404ing the shop pages. Use it on a schedule, when
someone with access leaves, or after a host reports its environment variables
may have been exposed.

Never paste a secret into a ticket, PR, chat or screenshot. Generate the
platform's own secrets with:

```bash
openssl rand -base64 32
```

## 1. The order, in one sitting

1. **Generate** new values for the five platform secrets (below) and keep the
   current values to hand. Two of them are needed as `_PREVIOUS`.
2. **Railway, API service: enter every change, but do not deploy yet.**
   Railway holds variable edits as staged changes until you deploy them, so
   this all lands as ONE deploy:
   - `TOKEN_ENCRYPTION_KEY` = new, `TOKEN_ENCRYPTION_KEY_PREVIOUS` = old
   - `WEB_PROXY_SECRET` = new, `WEB_PROXY_SECRET_PREVIOUS` = old
   - `SESSION_SECRET`, `ADMIN_TOKEN`, `UNSUBSCRIBE_TOKEN_SECRET` = new
   - every provider credential you have rolled (section 3)
3. **Supabase: reset the database password**, then put it into
   `DATABASE_URL` **and** `DIRECT_URL` in the staged Railway changes (both, or
   migrations read the old one). The running API loses the database from
   this moment, so go straight to step 4, at a quiet hour.
4. **Deploy, and read the boot log.** Wait for:
   `Key rotation: N moved to the new key, nothing left on the old one.`
   If it says anything opens with *neither* key, stop: the `_PREVIOUS` value is
   not the exact old one. Fix it and redeploy; nothing has been lost.
5. **Vercel, web project:** `WEB_PROXY_SECRET` = the same new value, then
   redeploy.
6. **Railway:** delete `TOKEN_ENCRYPTION_KEY_PREVIOUS` and
   `WEB_PROXY_SECRET_PREVIOUS`, deploy. The boot log is silent on a healthy
   boot.
7. **Revoke the old provider credentials** you kept alive for the overlap.

## 2. Platform secrets: what each change does

| Variable | Rotate how | What people notice |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | new + `_PREVIOUS` = old; the boot re-key moves stored Acuity/Square tokens and claimed-record proofs | Nothing. 🔴 Changing it **without** `_PREVIOUS` disconnects every Acuity and Square shop and detaches every claimed My ChairBack record at the customer's next open. |
| `WEB_PROXY_SECRET` | Railway new + `_PREVIOUS` = old, then Vercel, then drop `_PREVIOUS` | Nothing. 🔴 Changing one host without `_PREVIOUS` puts every visitor in one rate-limit bucket, which 429s the platform and 404s shop pages. |
| `SESSION_SECRET` | Hard cut, no overlap (an overlap would keep a leaked key working) | Every barber and every My ChairBack customer signs in again. The Lock Screen widget shows "Signed out" until the app is opened. Apple Wallet passes already added stop updating until the customer adds the pass again. Sign-ins mid-flight (Google, Apple, Stripe, Acuity, Square connect) need retrying. |
| `ADMIN_TOKEN` | Hard cut | Only the operator. Consider `ADMIN_IP_ALLOWLIST` too. |
| `UNSUBSCRIBE_TOKEN_SECRET` | Hard cut | An unsubscribe link in an already-sent marketing email keeps working until that client is sent the next one, which carries a working link. |

What `TOKEN_ENCRYPTION_KEY` rotation does **not** do: it does not revoke the
Acuity and Square tokens it protects. If the database and the key may both have
been exposed, those tokens may have been read; only the provider (or the shop
reconnecting) can revoke them.

Rows that live minutes (sign-in deliveries, phone recovery codes) are not moved.
They still open under either key until they expire, and a code requested in
the minute of the switch may need requesting again.

## 3. Provider credentials

Prefer each provider's overlap so the old credential works until the deploy
carrying the new one is live.

| Variable(s) | Where | Overlap |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Roll | Choose when the old key expires |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PLATFORM_WEBHOOK_SECRET` | Stripe → Webhooks → each endpoint → Roll secret | Old secret can stay valid up to 24h |
| `TWILIO_AUTH_TOKEN` | Twilio Console → API keys & tokens → secondary token | Deploy the secondary, then promote it (the old one dies on promote) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend → API keys / Webhooks | Create new, delete old after deploy |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | New secret key, delete old after deploy (legacy keys: rotate the JWT secret) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud → Credentials → the web client → Add secret | Both valid until you disable the old |
| `APPLE_OAUTH_PRIVATE_KEY` (+ `APPLE_OAUTH_KEY_ID`) | Apple Developer → Keys | New key, revoke old after deploy |
| `ACUITY_OAUTH_CLIENT_SECRET`, `ACUITY_WEBHOOK_SIGNING_KEY` | Acuity developer settings | Per Acuity |
| `SQUARE_OAUTH_CLIENT_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY` | Square Developer → the app | Per Square |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | Create new, delete old |
| `VERCEL_DOMAINS_TOKEN` | Vercel → Account → Tokens | Create new (scoped to the team), delete old |

Two that cost customers something, so decide them separately:

- **Apple Wallet certificates** (`WALLET_*_CERT_BASE64` / `_KEY_BASE64`): a new
  Pass Type certificate stops passes already in wallets from updating.
- **Web push** (`PUSH_VAPID_*`): new keys end every existing browser
  subscription; customers must opt in again. The public key is also on Vercel.

## 4. After

- Railway → the API's logs: no `token re-key` errors, no rise in 401s or 429s.
- Admin → preflight: every integration green.
- One Acuity shop and one Square shop (if any) sync a test booking.
