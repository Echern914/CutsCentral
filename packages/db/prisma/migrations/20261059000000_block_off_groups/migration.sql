/* BLOCK OFF TIME, AS ONE THING A BARBER CAN SEE, CHANGE AND TAKE BACK.

   A "Block off time" save can now cover several barbers, a run of days or a
   bounded weekly repeat, and it is written as one row per barber per day. The
   barber still thinks of it as ONE block, so the rows have to say which save
   they came from - and a save whose answer was lost must not write itself
   twice when it is tapped again.

   1. "groupId": the rows one save wrote. Edited or removed together. NULL on
      every existing row, which reads as a group of one.
   2. "requestId": the form's once-per-Save id, on every row of that save. A
      retry finds them and answers from them. CHECK-bounded like
      PunchLedger.requestId.
   3. "pattern": what the barber asked for - one span, the same hours each
      day, one continuous absence, or a weekly repeat. CHECK-pinned to those
      four words; NULL on existing rows.
   4. Unique (shopId, requestId, staffId, startsAt): the database backstop
      for a retry. One save never writes two rows for the same barber at the
      same start, so a second copy of the save collides on its first row.
      Rows with a NULL requestId (every existing row, and the old staff
      endpoint's) are distinct under it and unaffected.
   5. An index on (shopId, groupId) for "the whole group" reads.

   Additive. ADD COLUMN without a default writes no existing row and fires no
   trigger; the table's existing grants and tenant policy cover the new
   columns. Reversible by dropping the indexes, constraints and columns. */

ALTER TABLE "AvailabilityException"
  ADD COLUMN "groupId" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "pattern" TEXT;

ALTER TABLE "AvailabilityException"
  ADD CONSTRAINT "AvailabilityException_requestId_check"
  CHECK ("requestId" IS NULL OR char_length("requestId") BETWEEN 16 AND 64);

ALTER TABLE "AvailabilityException"
  ADD CONSTRAINT "AvailabilityException_pattern_check"
  CHECK ("pattern" IS NULL OR "pattern" IN ('single', 'daily', 'continuous', 'weekly'));

CREATE UNIQUE INDEX "AvailabilityException_shopId_requestId_staffId_startsAt_key"
  ON "AvailabilityException"("shopId", "requestId", "staffId", "startsAt");

CREATE INDEX "AvailabilityException_shopId_groupId_idx"
  ON "AvailabilityException"("shopId", "groupId");
