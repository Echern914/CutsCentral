# The booking-integrity contract

Two questions, deliberately kept apart. Collapsing them is how a completed cut
from this morning starts blocking this afternoon.

1. **Does this record reserve the chair?** — a *read* question, answered by
   `engines/chairOccupancy.ts` (status) and `engines/interval.ts` (span).
2. **May a new write be recorded here?** — a *write* question, answered by
   `lockStaffAndAssertSlotFree` (`engines/bookingWrite.ts`) inside an advisory
   lock. It asks (1) again, under the lock, and adds rules of its own.

A record can render on the calendar without reserving the chair (a cancelled
booking), and can reserve the chair without being "upcoming" (a walk-in
mid-cut). Neither follows from the other.

## Interval semantics

Half-open **`[startAt, endAt)`** everywhere. 10:00–10:30 collides with
10:15–10:45; it does **not** collide with 10:30–11:00. Zero-length and negative
spans are invalid, not harmless — under half-open, `[t, t)` contains no instant
and so overlaps nothing, which silently frees a chair. Production has 7 live
touching pairs that depend on the half-open reading; see
`booking-integrity-assessment.md`.

## The matrix

"Blocks" = removed from offered availability. "Write rejected" = a conflicting
new write is refused. "Override" = an *existing* authorized mechanism exists.

| Category | Renders on calendar | Blocks availability | Conflicting write rejected | Override allowed | Interval fields |
|---|---|---|---|---|---|
| **Native BOOKED** | yes | **yes** | **yes** | no | `Appointment.startsAt` / `endsAt` |
| **Native PENDING** (request / hold) | only when `holdExpiresAt IS NULL` | **yes**, until `holdExpiresAt` passes | **yes** (except the approve path, which passes `statuses:["BOOKED"]` — the row being approved is itself PENDING) | no | `startsAt` / `endsAt`, released early by `holdExpiresAt` |
| **Native CANCELED** | yes (struck through) | **no** | no | n/a | — |
| **Native NO_SHOW** | yes | **no** | no | n/a | — |
| **Native COMPLETED — historical** (`endsAt <= now`) | yes | **no** | no | n/a | `startsAt` / `endsAt` |
| **Native COMPLETED — in progress** (`endsAt > now`) | yes | **yes** | **yes** | no | `startsAt` / `endsAt` |
| **Walk-in (quick log)** | yes | **yes while `endsAt > now`**, then no | **yes** — and the write itself is now guarded | no | `startsAt = now`, `endsAt = now + Service.durationMin` |
| **Walk-in queue — Start Service** | yes | same as above | **yes**, but `completedInProgress:"ignore"` and `walkInCapacity:{excludeEntryId}` | no | as above |
| **Acuity / Square Visit** (`SCHEDULED`, `RESCHEDULED`, not promoted from a native row) | yes (all but `CANCELED`) | **yes, shop-wide** — a Visit carries no `staffId` | **yes** | no | `Visit.scheduledAt` / `endAt` (nullable — see below) |
| **Visit CANCELED / NO_SHOW / COMPLETED** | `CANCELED` hidden; others shown | **no** | no | n/a | — |
| **ExternalBlock** (Acuity blocked time) | yes | **yes, shop-wide** | **yes** (`externalBlocks:"enforce"`, the default) | **YES** — `externalBlockConfirmation` digest → audited `AppointmentOverride` | `startsAt` / `endsAt` |
| **AvailabilityException** (Block Off Time) | yes | **yes** | **yes** | no | `startsAt` / `endsAt`, one row per day |
| **Administrative override** | — | — | — | `AppointmentOverride`, `kind` = `"external_block"` **only** | `blockedFrom` / `blockedTo` |

### Notes that the table cannot carry

**A Visit blocks every chair.** Synced bookings have no `staffId`, so their span
is withheld shop-wide. Visits promoted from a native appointment are excluded
(`appointment: null`), because the `Appointment` row already blocks and is
authoritative on reschedule — counting both would double-book the barber against
himself.

**`Visit.endAt` is the only nullable end in the domain.** Both the read
(`slots.ts`) and the write guard (`bookingWrite.ts`) previously dropped NULL
rows, which is self-consistent and wrong in the same direction: the calendar drew
the visit and the booking page sold its time. `visitSpan()` now supplies a
conservative span instead.

**There is no override for appointment-vs-appointment conflict, and this PR does
not invent one.** `AppointmentOverride.kind` is `"external_block"` today. A
barber crossing a *block* confirms and is audited; a write that collides with a
real reservation is simply refused. Adding a second override kind is a product
decision, not a P0 fix.

**`completedInProgress: "ignore"` is for the barber's own hand only.** Starting
the next queued walk-in *is* the statement that the chair turned over. Every
customer-facing path keeps `"occupy"`, and so does the quick-log — see its call
site for why.
