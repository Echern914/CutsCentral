# Working in this repo

Traps that have each cost a real session real time. Short list on purpose — this
file is loaded into every session, so it only earns a line by having burned one.

## 🔴 `git checkout -- <file>` destroys uncommitted work

It reverts to HEAD, **not** to "before my last edit". There is no undo and the
content is not in any reflog.

The way it bites is specific and it does not feel dangerous at the time: you
deliberately break a file to prove a test catches the breakage (a good habit),
then reach for `git checkout --` to undo the break — and it also throws away
every uncommitted change you had made to that file, which may be an hour of
work you were about to commit.

**Instead:**

```bash
cp path/to/file.tsx /tmp/keep          # or edit a scratch copy
# ...break it, run the test, watch it fail...
cp /tmp/keep path/to/file.tsx          # restore YOUR version, not HEAD's
```

Or commit first and falsify against the commit. Related: a file can also *look*
reverted mid-task when it is simply absent from the commit a shared worktree is
parked on — verify against disk before concluding work was lost.

## 🔴 Heredocs mangle backslashes

`python - <<'EOF'` and `bash <<'EOF'` do not reliably preserve `\n` in string
literals: `"a\n\nb"` can arrive as a real two-line string, which silently
breaks TypeScript source (an unterminated string literal, or copy that renders
with hard line breaks).

Use the Edit/Write tools for any content containing `\n`, `\\`, or regex
escapes. If you must use a heredoc, verify the result by reading the file back
— the failure is invisible until the typechecker or a rendered page shows it.

## 🔴 One test database, shared by every suite

`TEST_DATABASE_URL` is in no `.env`; export it per shell:

```bash
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chairback_test"
```

**Never run two API suites at once.** They share the database, and tests that
count events per hour (`bookingRefusal.test.ts` is the canary) see the other
run's rows and fail. A "failure" in a file you did not touch is this until
proven otherwise — rerun that file alone before believing it.

## 🔴 `.env` points at DEV, and the prod credentials in it are stale

`DATABASE_URL` = the **dev** Supabase project (seeded fake data). Prod is a
different project, present only as commented `PROD_*` lines whose password has
since been rotated — they do **not** authenticate. So local scripts cannot
answer "what is true in production right now"; say so rather than reporting a
dev answer as if it were prod.

Never `prisma db push` against prod. `migrate deploy` only.

🔴 **Migrations read `DIRECT_URL`, not `DATABASE_URL`.** The datasource sets
`directUrl = env("DIRECT_URL")`, so overriding only `DATABASE_URL` on a
`prisma migrate` command silently targets whatever `.env` says — the **dev
Supabase project** — while printing a success message. Override BOTH:

```bash
DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL"   npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

Read the "Datasource" line it echoes back and confirm it says `localhost`
before believing it migrated the test database.

## Gates

CI runs Vercel builds only, so the local suites ARE the merge gate:

```bash
pnpm --filter @chairback/api test        # the big one; run it alone
pnpm --filter @chairback/web test
pnpm --filter @chairback/config test
pnpm --filter @chairback/api build       # Railway typechecks .test.ts too
pnpm --filter @chairback/web build       # the Vercel gate
```

`apps/web` carries an inherited typecheck error baseline (dual `@types/react`);
`next.config` sets `ignoreBuildErrors`, so **typecheck proves nothing on its
own** — the web *build* is the gate. To show your change adds no type debt,
count errors with your changes stashed and again with them applied, and compare;
the absolute number moves on its own as main advances.

🔴 **A client component must import `@chairback/config` by SUBPATH.** The
barrel (`@chairback/config`) re-exports `crypto.ts` and `session.ts`, so a
`"use client"` file importing from it drags `node:crypto` into the browser
bundle and `next build` dies with `UnhandledSchemeError`. Use
`@chairback/config/constants`, `/tierPerks`, `/features` and so on. Typecheck
passes either way — only the build catches it, which is the same reason the
build is the gate.

## Support surfaces

The in-app assistant and the MCP connector must stay **free to run** —
ChairBack supplies tools, never model tokens. `costBoundary.test.ts` and
`sharedBrain.test.ts` fail the build if a provider SDK, API key, or bare
`fetch()` appears in those surfaces. The SMS receptionist is the one AI surface
that costs money, which is what the Premium AI tier pays for.

Both in-app surfaces resolve through `resolveSupport` in
`@chairback/config/supportEngine`. Do not call `findHelp` directly from a
component: the engine owns actor gating and the guarantee that any non-answer
carries a route to a human.

🔴 **`primaryFor` in `help.ts` scores per TOKEN, not per phrase.** Declaring
`primaryFor: ["confirmation email"]` hands that entry the bare word *email* at
top weight, and it will swallow every other email question. An entry's `q` text
scores too, so a question containing a generic phrase steals queries about it.

🔴 **Shared truth belongs in `packages/config`, not inside one consumer.** The
shop policy sentences lived as local consts in `receptionist/prompt.ts` and
handled 2 of 4 payment modes, so a deposit-mode shop's receptionist contradicted
its own booking page for 18 days. They now live in `config/shopPolicy.ts`.
Before writing a formatter, check whether another surface already answers the
same question.
