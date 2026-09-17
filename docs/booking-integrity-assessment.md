# Booking integrity P0 — production data assessment

Read-only aggregate counts taken against production on 2026-09-17, via
`railway run` (owner connection, `SELECT` only, no customer fields read).
Re-runnable: `apps/api/scripts/interval-audit.mjs`.

## Headline: no production data repair is needed, and no migration belongs in this PR

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

1. **No backfill, no migration.** There is nothing forward-dated to repair.
2. **🔴 Do NOT add `NOT NULL` to `Visit.endAt`.** It would fail against 21,115
   historical rows, and those rows are harmless. The reads are made
   NULL-tolerant instead, which is the fix that actually closes the hole.
3. **Half-open is not a preference.** 7 live pairs depend on it.
4. Historical repair, if ever wanted, is a separate change with its own
   assessment — it is cosmetic (past rows) and must not ride along with a P0.
