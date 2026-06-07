# ChairBack - local setup

## 1. Database (Supabase)

1. Create a free project at https://supabase.com (note your DB password).
2. In the dashboard: **Project Settings to Database to Connection string**.
3. Copy two strings into `.env` (copy `.env.example` to `.env` first):
   - **`DATABASE_URL`** - the **Transaction pooler** string (host contains `-pooler`, port **6543**). Append `?pgbouncer=true&connection_limit=1`.
   - **`DIRECT_URL`** - the **Direct connection** string (port **5432**). Used only by `prisma migrate`.
4. Run migrations + generate client + seed:
   ```
   pnpm db:migrate        # creates tables + RLS roles/policies (uses DIRECT_URL)
   pnpm db:seed           # creates Drick's dev shop + barber login
   ```
   The migrations include Row-Level Security (RLS) defense-in-depth. Keep
   `DB_RLS_ENFORCE="true"` (the default). If you ever connect with a role that
   can't `SET ROLE chairback_app`, set it to `false` to fall back to app-layer
   isolation only.

## 2. Secrets

Generate the two crypto secrets and paste into `.env`:
```
# session signing secret (any long random string)
openssl rand -base64 48

# token encryption key - MUST decode to exactly 32 bytes
openssl rand -base64 32
```
(No openssl on Windows? `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)

## 3. Acuity OAuth app

Register once at https://acuityscheduling.com/oauth2/register. Set the redirect URI to
`<API_BASE_URL>/api/acuity/oauth/callback`. Paste `ACUITY_OAUTH_CLIENT_ID` / `_SECRET` into `.env`.

## 4. Twilio

One shared number for all shops. Paste `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM_NUMBER`.
Keep `DRY_RUN="true"` until you're ready to actually send.

## 5. Run

```
pnpm --filter @chairback/api dev     # API on :4000
pnpm --filter @chairback/web dev     # web on :3000
```

## Test commands

```
pnpm test                            # all packages
pnpm --filter @chairback/config test # pure logic (no DB)
pnpm --filter @chairback/db test     # DB-backed isolation tests (needs DATABASE_URL)
```
