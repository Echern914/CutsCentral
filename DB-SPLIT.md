# Splitting prod and dev databases (do before going public)

Right now there is **one** Supabase project and it is **production**
(`db.czqjnhwxcubnskyfamvb.supabase.co`, the 3 real shops). Your local `.env`
points `DATABASE_URL`/`DIRECT_URL` at it, so `pnpm dev` and every one-off Prisma
script on your machine read and write **real customer data**. The test suite is
already safe (the guard in `apps/api/vitest.setup.ts` refuses a Supabase host),
but local dev is not.

The whole coupling lives in your single gitignored `.env` (verified: no script
hardcodes the prod host). So the fix is small: give **dev its own Supabase
project**, and let the prod project be touched only by Railway at runtime plus
deliberate migration deploys from your machine.

## End state

| | Project | Who connects to it |
|---|---|---|
| **prod** | existing `czqjnhwxcubnskyfamvb` | Railway (runtime, pooler) + you running `prisma migrate deploy` on purpose |
| **dev** | NEW Supabase project | your local `pnpm dev`, local Prisma scripts, seeding |
| **test** | local Postgres or a 3rd throwaway project | the test suite via `TEST_DATABASE_URL` (still unset) |

## Steps (your clicks + a few commands)

### 1. Create the dev Supabase project
1. Supabase dashboard -> New project. Name it `chairback-dev`. Same region as prod
   (lower latency, and keeps the pooler host format identical).
2. Set a DB password you'll keep in `.env` (NOT the prod password).
3. Project Settings -> Database -> Connection string. Copy both:
   - **Transaction pooler** (host has `-pooler`, port 6543) -> dev `DATABASE_URL`
   - **Direct connection** (port 5432) -> dev `DIRECT_URL`

### 2. Point local `.env` at dev
Edit `.env` (gitignored, never committed):
```
DATABASE_URL="postgresql://postgres.<DEVREF>:<DEVPASS>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10"
DIRECT_URL="postgresql://postgres.<DEVREF>:<DEVPASS>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```
Leave the prod strings in `DEPLOY.md` (also gitignored) so you still have them
for migration deploys.

### 3. Build the dev schema from migrations (not a blind push)
From the repo root, with the dev `.env` loaded:
```
pnpm --filter @chairback/db generate
pnpm --filter @chairback/db migrate:dev   # applies all 20 migrations to the empty dev DB
```
This replays the real migration history, so dev matches prod's schema exactly.

### 4. Seed dev with fake data (now safe)
```
pnpm db:seed
```
`packages/db/prisma/seed.ts` creates the `drick@example.com` demo shop. This is
exactly the junk you must NEVER put in prod, and now it has a home. Add more dev
shops freely.

### 5. Lock the guardrails so this can't regress
- **Keep `TEST_DATABASE_URL` unset against any Supabase host.** Set it to a local
  Postgres or the dev project's DIRECT url ONLY if you want DB-backed tests to run
  (see "Running the full test suite" below). Never point it at prod.
- The test bootstrap already hard-stops on a `supabase.co/.com` host. Leave it.
- Optional belt-and-suspenders: a `predev` guard that refuses to start `pnpm dev`
  if `DATABASE_URL` contains the prod project ref. Say the word and I'll add it.

## How prod gets migrated AFTER the split (this part is unchanged)

Railway cannot reach Supabase direct (5432), so migrations still run from your
machine, not in the Railway start command. To deploy the punch-reversal migration
(or any future one) to prod:
```
# load the PROD strings from DEPLOY.md into this shell only, then:
pnpm --filter @chairback/db exec prisma migrate deploy
```
`migrate deploy` applies only pending migrations and never resets, so it's the
safe prod verb (as opposed to `migrate dev`, which can prompt to reset).

**Always apply a new migration to dev (step 3) first, confirm the app works
against dev, THEN deploy to prod.** That single habit is what the split buys you.

## Running the full test suite (the thing this box currently can't do)

The DB-backed specs (e.g. `services/punch.test.ts`, `routes/ledgerEdit.test.ts`,
`consent.test.ts`) need a reachable throwaway Postgres. Two options:
- **Local Postgres** (best): install Postgres or run Docker
  `postgres:16`, create `chairback_test`, set
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/chairback_test`,
  then `pnpm --filter @chairback/api test`.
- **A third Supabase project** named `chairback-test`: set `TEST_DATABASE_URL` to
  its DIRECT url. Slower (network round-trips per test) but no local install. The
  guard's prod-host block would also block this Supabase host, so you'd run tests
  via the documented `TEST_DATABASE_URL` path, which the guard honors.

## Why not just snapshot prod into dev?

You could `pg_dump` prod and restore into dev to get realistic data, but it copies
real client phone numbers into a less-guarded database, which is the opposite of
what you want before launch. Seed fake data instead. If you ever need
prod-shaped data, anonymize on the way in.
