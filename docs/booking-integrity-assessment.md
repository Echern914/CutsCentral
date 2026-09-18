# Booking integrity P0 — production data assessment

Read-only aggregate counts taken against production on 2026-09-17, via
`railway run` (owner connection, `SELECT` only, no customer fields read).
Re-runnable: `apps/api/scripts/interval-audit.mjs`.

## Headline: no production data REPAIR is needed

(Superseded in part — see "The migration this PR does carry" at the end. No
existing row needs repairing; durable conflict records and receipt idempotency
do need new, additive schema.)

Every broken span in production is **in the past**. Nothing currently on the
books can cause a future double-book through a malformed interval. The fix is
therefore entirely code-level — stop creating new bad spans, and stop the reads
from silently dropping the old ones.

## Appointment spans — clean

| status | total | zero-length | negative |
|---|---|---|---|
| BOOKED | 20 | 0 | 0 |
| CANCELED | 86 | 0 | 0 |
| COMPLETED | 166 | 0 | 0 |
| NO_SHOW | 1 | 0 | 0 |

`Appointment.startsAt`/`endsAt` are both NOT NULL and no row violates
`endsAt > startsAt`.

## Visit spans — 21,115 null ends, all historical

| status | total | null end | zero-length | negative |
|---|---|---|---|---|
| SCHEDULED | 20,033 | **19,924** | 0 | 0 |
| CANCELED | 1,676 | 1,186 | 0 | 0 |
| COMPLETED | 3,067 | 0 | **6** | 0 |
| NO_SHOW | 38 | 5 | 0 | 0 |

`Visit.endAt` is the only nullable end in the booking domain
(`schema.prisma:1598`), and 99.5% of SCHEDULED visits carry NULL. That looks
alarming until the same question is asked about the future:

| future (`scheduledAt > now()`) | total | null end | zero-length |
|---|---|---|---|
| SCHEDULED | 108 | **0** | **0** |
| CANCELED | 3 | 0 | 0 |

**Zero future visits have a broken span, across zero shops.** The null ends are
historical Acuity imports from before `ingest.ts` began defaulting `endAt`
(`ingest.ts:58-72`, which now never stores null). The 6 zero-length COMPLETED
visits are consistent with the `visit.ts:151` edit defect having fired a handful
of times — all in the past.

## Existing overlaps the repaired rule would reject

| check | count |
|---|---|
| live future appointment pairs that overlap on one chair | **0** |
| appointment pairs that merely **touch** (`a.endsAt = b.startsAt`) | **7** |

Nothing to clean up — and the 7 touching pairs are the load-bearing number
here. They are legitimate back-to-back bookings. **A closed-interval rule would
reject all 7**, breaking real bookings on live shops. This is the production
evidence for choosing half-open `[start, end)`.

## Blocks

| table | total | invalid span |
|---|---|---|
| ExternalBlock | 283 | 0 |
| AvailabilityException | 30 | 0 |

## Consequences for this PR

1. **No backfill, and no migration of EXISTING data.** There is nothing
   forward-dated to repair. (New, additive schema is a separate matter - see
   "The migration this PR does carry".)
2. **🔴 Do NOT add `NOT NULL` to `Visit.endAt`.** It would fail against 21,115
   historical rows, and those rows are harmless. The reads are made
   NULL-tolerant instead, which is the fix that actually closes the hole.
3. **Half-open is not a preference.** 7 live pairs depend on it.
4. Historical repair, if ever wanted, is a separate change with its own
   assessment — it is cosmetic (past rows) and must not ride along with a P0.

---

## The migration this PR does carry

The original "no migration" claim was true of the first two fixes and stopped
being true once conflicts had to outlive a log line and receipts had to survive
a retry. `20260930000000_booking_conflicts_and_receipt_idempotency` is
**expand-only**: every statement is additive, and a running old API neither
reads nor writes any of it.

| change | shape | why it is safe on existing data |
|---|---|---|
| `Appointment.operationId TEXT` | nullable | all 274 existing rows stay NULL |
| partial unique `(shopId, operationId) WHERE operationId IS NOT NULL` | partial | every existing row is NULL and is simply **not in the index**; see the correction below |
| `BookingConflict` table + RLS | new | nothing to migrate |
| unique `(shopId, receiptId, conflictingKind, conflictingId)` | new table | this index **is** the deduplication: repeated detection writes nothing |

### 🔴 Correction: why the index is partial

An earlier version of this document, and the comment in the migration itself,
said the partial predicate was **required** — that without the `WHERE` clause
the index "cannot be created at all", because all 274 existing rows are NULL and
would collide. **That is wrong, and it was wrong about PostgreSQL itself.**

PostgreSQL treats NULLs as **distinct** in a unique index by default, so any
number of NULL rows coexist in a plain unique index. Measured rather than
argued, on PG 17.10 against the real column type: a plain
`UNIQUE (shopId, operationId)` built over **350** NULL rows without complaint,
and a 351st NULL still inserted afterwards. The only thing that would have
collided is the PG-15+ opt-in `NULLS NOT DISTINCT`, which this migration does
not use and which `conflict-verify.mjs schema` asserts is absent.

The partial index is still the right shape, for the reasons that survive
contact with the engine:

* it indexes only rows that can participate in idempotency, so it holds the
  receipts rather than every appointment ever booked;
* it states the scope in the schema — "this constraint is about rows that carry
  an operation id" — instead of leaving it implied by NULL semantics;
* it does not depend on NULLs-are-distinct staying the default. A constraint
  whose correctness rests on an unstated default is one setting away from
  rejecting every legacy row.

`apps/api/src/routes/migrationNullSemantics.test.ts` pins all three behaviours
against the real engine — unlimited NULLs accepted, a duplicate non-null
rejected, the same id in another shop allowed — plus a `pg_index` assertion that
the deployed index really is partial and really is not `NULLS NOT DISTINCT`. The
lesson is the general one: **a comment asserting engine behaviour is worth
nothing until something executes it.**

### 🔴 Correction: the notification column was removed

An earlier draft added `BarberNotifyPref.conflictEnabled BOOLEAN NOT NULL
DEFAULT true`. It is gone, because **nothing could ever write it** — no route,
no settings toggle — which made it a preference in name only and exactly the
kind of misleading model this audit was looking for.

The policy is now stated in code instead: a conflict alert is **mandatory in
kind** (there is no switch; a double-booked chair is operational integrity, not
communication) and **optional in channel** (it still respects `pushEnabled`,
`smsEnabled`, `emailEnabled` — mandatory decides whether there is something to
say, never by what route). The honest consequence, pinned by
`services/conflictAlertPolicy.test.ts`: with push off, SMS behind `DRY_RUN` and
email off by default, **the alert can reach nobody**. That is why the two
deliveries that cannot be switched off — the amber panel in the response and the
durable `BookingConflict` row — are the real ones.

### Migration naming: a sequence, not a wall clock

`20260930000000` is **not** a date claim, and this repo's migration prefixes
have not been wall-clock timestamps for some time. The latest migration on
`main`, `20260929000000_acuity_block_all_calendars`, was committed on
**2026-09-17** and is already applied in production; the sequence has drifted
about twelve days ahead of the calendar.

So `20260930000000` is simply the next value after everything on `main`, in
production (166 applied), and on every other open branch. **Renaming it to a
real current timestamp would sort it *before* eleven already-applied
migrations** — the reordering hazard, inverted and much worse. The prefix is an
ordering key; the only rule that matters is that a new migration sorts after
every migration that already exists.

**Deploy order.** Expand first, then code — Railway already does this
(`railway.json` `preDeployCommand` runs `migrate deploy` before traffic). There
is no contract step: nothing is dropped, narrowed or made NOT NULL, so the old
and new code can both run against this schema.

**Rollback.** Revert the commits and redeploy. The schema stays — and that is
the honest position rather than a pretence:

- `operationId` values already written stay written. Harmless: the old code
  never reads the column, and the partial index only constrains rows that have
  one.
- `BookingConflict` rows already written stay written. They are a record that a
  chair was double-booked; deleting them to tidy up a rollback would destroy
  exactly the evidence the table exists for.
- The controlled production check that proves all of this is
  `docs/booking-conflict-production-verification.md`, backed by the read-only
  `apps/api/scripts/conflict-verify.mjs`.
- Nothing customer-facing depends on either, so a revert is a code-only step.

Dropping the table would be a separate, deliberate contract migration, and only
once nobody wants the history.
