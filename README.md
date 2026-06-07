# ChairBack

A multi-tenant client-retention platform for barbershops, built on Acuity Scheduling.
Any barber signs up, connects their own Acuity account, and gets:

- **Auto-tracked visits** - every Acuity appointment flows in via webhooks. No punch cards.
- **Loyalty punch-card** - every completed visit earns a punch toward a configurable reward.
- **Rebooking nudges (the core value)** - a daily job computes each client's personal visit
  cadence and sends ONE rebooking SMS when they're overdue with no upcoming booking.
- **Barber dashboard** - at-risk clients, nudges sent, rebookings recovered, punch leaderboard.
- **Client rewards page** - a premium dark mobile page where the magic link IS the auth.

> The product name lives in one constant: `packages/config/src/constants.ts to APP_NAME`.

## Architecture

A pnpm + Turborepo monorepo:

| Package | What | Deploys to |
|---|---|---|
| `apps/api` | Node + Express + TypeScript. Webhooks, Acuity OAuth + sync, nudge engines, REST API. | Railway |
| `apps/web` | Next.js 14 (App Router) + Tailwind + framer-motion. Rewards page + barber dashboard. | Vercel |
| `packages/db` | Prisma schema + generated client + the `forShop` tenant-scoping helper. | - |
| `packages/config` | Shared env (Zod), constants, time/crypto/session helpers. | - |

**Multi-tenancy:** shared Postgres, `shopId` on every tenant table, every tenant query goes
through `forShop(shopId)` (`packages/db/src/tenant.ts`). Each route derives `shopId` from
exactly one of: the **session cookie** (dashboard), a **magicToken** (rewards), or an
**unguessable webhookSecret in the URL path** (webhooks) - never from a request param/body.

## Local development

See [SETUP.md](./SETUP.md) for the step-by-step. In short:

```bash
pnpm install                 # installs all workspaces; generates the Prisma client
cp .env.example .env         # fill in DATABASE_URL/DIRECT_URL (Supabase), secrets, Acuity, Twilio
pnpm db:migrate              # apply migrations (uses DIRECT_URL)
pnpm db:seed                 # create a dev barber + Drick's test shop
pnpm --filter @chairback/api dev    # API on :4000
pnpm --filter @chairback/web dev    # web on :3000
```

### Generating secrets
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # TOKEN_ENCRYPTION_KEY (must be 32 bytes)
```

## Acuity OAuth setup

This is multi-tenant, so each barber connects via OAuth2 (not a shared API key).

1. Register ONE developer app at <https://acuityscheduling.com/oauth2/register>.
2. Set the redirect URI to `${API_BASE_URL}/api/acuity/oauth/callback`.
3. Put the credentials in `.env`: `ACUITY_OAUTH_CLIENT_ID`, `ACUITY_OAUTH_CLIENT_SECRET`,
   `ACUITY_OAUTH_REDIRECT_URI`.
4. Barbers click **Connect Acuity** in onboarding to consent to we store an (encrypted) token,
   subscribe per-shop webhooks, and backfill their history automatically.

### Three "verify against a live account" points
The public Acuity docs are thin on these; the code handles them behind seams and they should be
confirmed against a real OAuth app:
1. **Token lifecycle** - whether `expires_in` / `refresh_token` are issued. Refresh is reactive
   on 401; if no refresh grant exists, the dashboard surfaces "reconnect Acuity".
2. **Dynamic Webhooks subscription endpoint** - `apps/api/src/acuity/webhookSubscription.ts`
   posts `{event, target}` per shop; verify the exact shape. Failures are logged and the
   connection still succeeds.
3. **OAuth webhook HMAC key** - under-documented for OAuth apps. Per-shop routing uses the
   unguessable URL path token as the primary authenticator; HMAC verify
   (`apps/api/src/acuity/signature.ts`) is wired and used when a key is available.

## Twilio / SMS

One **shared platform number** sends for all shops; the shop name is in every message body.

- Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
- **A2P 10DLC:** US application-to-person SMS requires brand + campaign registration through
  Twilio before production sending. The nudge template includes "Reply STOP to opt out", and
  inbound STOP is handled at `POST /webhooks/twilio/inbound` (sets `optedOut`).
- Keep `DRY_RUN="true"` until you've registered A2P and verified the message copy. Dry-run
  logs who *would* be nudged and never sends.

## Deploy

### API to Railway
1. New Railway project from this repo; add a PostgreSQL plugin (or point `DATABASE_URL` at Supabase).
2. Service settings:
   - Install: `pnpm install`
   - Build: `pnpm --filter @chairback/api build`
   - Start: `pnpm --filter @chairback/api start`
   - Release/deploy command: `pnpm --filter @chairback/db migrate:deploy`
3. Set all `apps/api` env vars. `ENABLE_SCHEDULER="true"` (single replica only - see below).

### Web to Vercel
1. Import the repo; **Root Directory = repo root**.
2. Install: `pnpm install` · Build: `pnpm --filter @chairback/web build` · Framework: Next.js.
3. Env: `API_BASE_URL` (the Railway API URL), `APP_BASE_URL` (the Vercel URL).

### Scheduler note
The nudge sweep, status-promotion, and attribution jobs run via `node-cron` inside the single
API process (`ENABLE_SCHEDULER=true`). This assumes **one API replica** - if you scale out,
either move to Railway cron hitting the `/admin/*` endpoints or wrap the sweep in a
`pg_advisory_lock` (a noted seam in `apps/api/src/scheduler.ts`).

## Operations runbook

1. **Backfill** a shop after connect (automatic on OAuth, or manual):
   `POST /admin/backfill/:shopId` with `Authorization: Bearer $ADMIN_TOKEN`.
2. **Verify** in the dashboard: clients + visit history imported, cadence populating.
3. **Preview nudges** safely: `POST /admin/nudge-sweep?dryRun=true` - logs who would be nudged.
4. **Enable the scheduler** (`ENABLE_SCHEDULER=true`) once the data looks right.
5. **Go live**: register Twilio A2P, then set `DRY_RUN="false"`.

Other admin endpoints (all `Bearer $ADMIN_TOKEN`): `POST /admin/promote` (status promotion),
`POST /admin/attribution` (link bookings to nudges).

## Testing

```bash
pnpm test                              # all packages
pnpm --filter @chairback/config test   # pure logic (median, crypto, session) - no DB
pnpm --filter @chairback/db test       # tenant-isolation guard - needs DATABASE_URL
pnpm --filter @chairback/api test      # auth, OAuth CSRF, webhook idempotency, engines - needs DATABASE_URL
```

Tests are fixture-based - no live Acuity or Twilio calls (a fake `MessageProvider` is injected).

## Security

**Tenant isolation - two layers:**
1. **App layer** - every tenant query goes through `forShop(shopId)`
   (`packages/db/src/tenant.ts`). `shopId` is derived only from the session
   cookie, a magicToken, or a webhookSecret - never from a request param/body.
2. **Database layer (RLS defense-in-depth)** - Postgres Row-Level Security is
   enabled and `FORCE`d on every tenant table (`Client`, `Visit`, `PunchLedger`,
   `Nudge`). Each tenant transaction does `SET LOCAL ROLE chairback_app` and sets
   `app.current_shop_id`; policies restrict rows to that shop. Even an app-layer
   bug or a leaked DB credential cannot cross tenants. Verified by
   `packages/db/src/rls.test.ts` (a cross-tenant insert is rejected by the DB).

   Run the RLS migrations (`pnpm db:migrate` / `migrate:deploy`) then keep
   `DB_RLS_ENFORCE="true"`. The browser never touches the database - there is no
   Supabase anon key or client-side DB access; all access is through the API.

**Rate limiting** (`apps/api/src/middleware/rateLimit.ts`):
- Auth (signup/login): 20 / 15 min per IP.
- Public rewards lookup: 30 / min per IP (blunts magic-token enumeration).
- Acuity OAuth callback: 15 / min per IP. Webhook receivers: 120 / min per IP.
- Dashboard reads: 120 / min per user. **SMS-sending** actions (nudge,
  sweep-preview): 10 / min per user. Admin endpoints: 10 / min per token.

**Secrets:** Acuity OAuth tokens are AES-256-GCM encrypted at rest and isolated
in `AcuityConnection`; Pino redacts tokens/secrets from logs. Sessions are signed
httpOnly+Secure+SameSite=Lax cookies; passwords are argon2id.

## Out of scope (seams only)

Stripe billing (`Shop.plan` is inert), per-shop Twilio numbers, email channel, email
verification, multiple shops per barber, client auto-merge.
