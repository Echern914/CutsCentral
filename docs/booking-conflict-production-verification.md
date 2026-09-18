# Booking-integrity P0 — controlled production verification

**Status: NOT YET RUN.** Every box below is unchecked. This document is the
procedure, written before the deploy so the pass/fail criteria cannot be
adjusted afterwards to match whatever happened.

## Why this exists

The alternative to a controlled test is waiting for a real customer to be
double-booked — which means the first evidence that the fix works is a customer
standing in a shop next to somebody already in the chair. That is not a test,
it is an incident with extra steps. So the conflict is **manufactured on a
dedicated fixture**, on a real production deploy, at a time nobody is working.

## The fixture — and the one rule

Everything below happens on a **dedicated verification shop**, created through
the ordinary signup flow like any other shop, with:

- its own owner login (`chairback-verify+p0@…`), not a real barber's account;
- `bookingMode = native`, one staff row, one service;
- **no Acuity or Square connection** — nothing here may reach an external
  calendar, because an external calendar belongs to a real business;
- a `Walk-in` service auto-provisioned on first use, exactly as a real shop's is.

> 🔴 **THE ONE RULE: no step reads, writes, cancels or deletes a record
> belonging to `cherncuts`, `drickcuttinup`, or any other real shop.** Not to
> "check it still works", not to compare. The verification proves the deployed
> code behaves correctly; it does not audit other people's calendars. Any step
> that cannot be done on the fixture is not done.

Uptown Fades is a demo account and is **not** the fixture — a demo account is
still somebody's demo.

## Sequencing: the migration goes first, alone

Railway runs `migrate deploy` as `preDeployCommand`, before the new container
takes traffic. That ordering is what makes this expand-only migration safe, so
it is verified rather than assumed.

- [ ] **1. Migration applies before new code serves traffic.**
      Watch the Railway deploy log: `migrate deploy` must report
      `20260930000000_booking_conflicts_and_receipt_idempotency` applied, and
      the health check must go green *after* it.
      Then confirm the shape against production (read-only):

      ```bash
      railway run node apps/api/scripts/conflict-verify.mjs schema
      ```

      Expect: `operationId` column present and nullable; the index
      `Appointment_shop_operation_key` present, UNIQUE and **partial**;
      `BookingConflict` present with RLS enabled *and* forced and exactly one
      policy; **no** `BarberNotifyPref.conflictEnabled` column.

- [ ] **2. Existing bookings and walk-ins still work.**
      On the FIXTURE shop: load the dashboard calendar, open an appointment,
      record an ordinary non-conflicting walk-in. All three must behave exactly
      as before. Separately, confirm the production `Appointment` count has not
      changed except by the fixture's own rows — the migration must not have
      touched a single existing row:

      ```bash
      railway run node apps/api/scripts/conflict-verify.mjs baseline
      ```

      Expect: every pre-existing appointment still has `operationId IS NULL`,
      and the total row count moved only by what the fixture created.

## The conflict itself

- [ ] **3. Create a controlled conflicting reservation.**
      On the fixture, book a normal appointment on the fixture chair covering
      **now**, through the ordinary dashboard create flow. This is a real
      reservation, made the way a barber makes one.

- [ ] **4. The walk-in is RECORDED, not refused.**
      Record a walk-in on that same chair for that same time.
      Expect **HTTP 201**, not 409. This is the product rule: a reservation
      request that collides is refused; a **receipt** for work already done is
      recorded and flagged. A 409 here is a hard fail and a rollback trigger.

- [ ] **5. The amber warning appears on the real dashboard.**
      Not in a log, not in a test — on the screen. The walk-in bar must show the
      amber panel, persistently (it must survive a few seconds without being
      swept away by a toast), saying: the walk-in is on the books · this chair is
      double-booked · check the calendar and call whoever is booked · nothing was
      discarded. **Screenshot it.** This is the one step no automated gate can
      cover, and the whole PR exists because this feedback was previously being
      thrown away.
      🔴 It must **not** say the payment was saved: the amount is barber-typed
      and ChairBack never handled it.

- [ ] **6. Exactly one `BookingConflict` is stored.**

      ```bash
      railway run node apps/api/scripts/conflict-verify.mjs conflicts <fixtureShopId>
      ```

      Expect exactly **1** row: `conflictingKind = "appointment"`,
      `conflictingId` = the appointment from step 3, `source =
      "walk_in_quick_log"`, `resolvedAt = NULL`, and an overlap interval that
      matches the real overlap.

- [ ] **7. Exactly one manager alert is emitted.**
      The fixture owner should receive one push. If none arrives, check whether
      that account has a registered push subscription **before** calling it a
      failure — with no device registered, no push is the correct behaviour, and
      the durable row plus the amber panel are then the delivery. Record which
      of the two happened; do not record "alert works" without knowing which.

## Idempotency, against the real database

- [ ] **8. A retry with the same operation id returns the ORIGINAL result.**
      Re-submit the identical walk-in with the same `operationId`.
      Expect 201, the **same** appointment id as step 4, and the conflict still
      reported in the body (the warning must not disappear on the second ask).

- [ ] **9. That retry creates no second receipt, conflict or alert.**

      ```bash
      railway run node apps/api/scripts/conflict-verify.mjs conflicts <fixtureShopId>
      ```

      Expect: still exactly 1 walk-in receipt, still exactly 1 conflict row, and
      no second push.

- [ ] **10. A NEW operation id creates a genuinely separate receipt.**
      Submit again with a *different* `operationId`. Expect 201, a **different**
      appointment id, and a second receipt. This is the half that matters most:
      both live shops log real walk-ins seconds apart, and an idempotency rule
      that swallowed the second one would delete money that was actually taken.

## Cache

- [ ] **11. An Acuity change is reflected immediately.**
      🔴 **Not on the fixture** — the fixture has no Acuity connection, and one
      must not be created, because connecting Acuity means reaching a real
      calendar. This step is therefore verified on the **staging/dev** shop that
      already has a sandbox Acuity connection, not in production: ingest an
      appointment and confirm the very next `/api/book/:slug/day` no longer
      offers that slot. `acuityCacheInvalidation.test.ts` covers the same path
      against the real ingest and the real cached endpoint.
      If no sandbox connection exists, record this step as **not verified in
      production** rather than claiming it.

## Cleanup — through supported paths only

- [ ] **12. Remove the test records.**
      - Cancel the step-3 appointment via `POST /api/booking/appointments/:id/cancel`
        (the supported path), from the fixture's own dashboard.
      - Delete the **whole fixture shop** through the ordinary account-deletion
        path. `BookingConflict.shopId` is `ON DELETE CASCADE`, so the conflict
        rows go with it — no hand-written `DELETE` against production, and
        nothing outside the fixture is touched.
      - Re-run `conflict-verify.mjs baseline` and confirm production is back to
        its pre-verification counts.

      🔴 **Do not hand-delete `BookingConflict` rows for any real shop.** They
      are the record that a chair was double-booked; tidying them away destroys
      exactly the evidence the table exists for.

## Rollback

**Triggers — any one of these, immediately:**

| Trigger | Why it is fatal |
|---|---|
| Step 1 fails: `migrate deploy` errors, or the app serves traffic before it | Code reading a column before its migration is the 2026-09-01 login outage |
| Step 4 returns **409** | The receipt was refused; a walk-in that cannot be recorded loses money that is already in the till |
| Any walk-in returns 5xx | The route was working before this PR |
| Step 9 shows a **second receipt** | A retry is double-recording money — worse than the bug being fixed |
| Ordinary (non-conflicting) booking or walk-in regresses | Blast radius beyond the fix |

**Procedure:** revert the code commits and redeploy. That is the whole rollback
— it is a code-only step, because the migration is expand-only and the old code
neither reads nor writes any of it.

**🔴 THE SCHEMA STAYS, AND SO DO THE ROWS.**

- `operationId` values already written stay. The old code never reads the
  column, and the partial index only constrains rows that have one.
- `BookingConflict` rows already written stay. **Preserving them is the point:**
  if the code is rolled back, any conflict it caught is the only durable record
  that a chair was double-booked, and a barber may still need to ring that
  customer. Deleting them to "clean up" a rollback throws away real evidence
  about real bookings.
- Dropping the table would be a separate, deliberate contract migration, taken
  only once nobody wants the history.

## Known gap, recorded here rather than discovered later

**`BookingConflict` has no reader yet.** The row is durable and correct, but
there is no dashboard list and no resolve action — `resolvedAt` and
`resolvedByUserId` exist and nothing writes them. Today a manager learns about a
conflict from the amber panel and the push; reading the history needs database
access, which is why step 6 uses a script.

That is a real limitation of this PR's scope, not an oversight: the P0 was to
stop losing the information. Surfacing it (a conflicts list beside the calendar,
a resolve action, and a readiness item) is the immediate follow-up and should
not ride along inside a P0.
