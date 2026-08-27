/* ------------------------------------------------------------------ */
/* WALK-IN MODE PR 2: kiosk phone verification + tracking sessions.    */
/*                                                                     */
/* Additive only, still dark behind WALK_IN_MODE_ENABLED +             */
/* Shop.walkInEnabled. Two pieces:                                     */
/*   1. WalkInPhoneCode - one six-digit-OTP challenge per (shop,       */
/*      phone), code stored as a scope-bound hash only, single-use     */
/*      via CAS, carrying the single-use check-in proof.               */
/*   2. Tracking SESSION columns on WalkInEntry - the SMS link's       */
/*      credential lives in the URL fragment and is exchanged once     */
/*      (POST) for a bounded session, so no credential ever appears    */
/*      in an access log or referrer.                                  */
/* ------------------------------------------------------------------ */

ALTER TABLE "WalkInEntry" ADD COLUMN "trackSessionHash" TEXT;
ALTER TABLE "WalkInEntry" ADD COLUMN "trackSessionExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "WalkInEntry_trackSessionHash_key"
  ON "WalkInEntry"("trackSessionHash");

CREATE TABLE "WalkInPhoneCode" (
    "id"              TEXT NOT NULL,
    "shopId"          TEXT NOT NULL,
    "phone"           TEXT NOT NULL,
    "codeHash"        TEXT NOT NULL,
    "attemptCount"    INTEGER NOT NULL DEFAULT 0,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "consumedAt"      TIMESTAMP(3),
    "proofHash"       TEXT,
    "proofExpiresAt"  TIMESTAMP(3),
    "proofConsumedAt" TIMESTAMP(3),
    "lastSentAt"      TIMESTAMP(3) NOT NULL,
    "sendCount"       INTEGER NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalkInPhoneCode_pkey" PRIMARY KEY ("id")
);

/* ONE row per shop+phone - "one active challenge" is a table shape, not a
   convention, and it is also the accumulation bound (rows <= phones seen;
   the challenge path deletes long-expired rows opportunistically). */
CREATE UNIQUE INDEX "WalkInPhoneCode_shopId_phone_key"
  ON "WalkInPhoneCode"("shopId", "phone");
CREATE UNIQUE INDEX "WalkInPhoneCode_proofHash_key"
  ON "WalkInPhoneCode"("proofHash");
CREATE INDEX "WalkInPhoneCode_shopId_expiresAt_idx"
  ON "WalkInPhoneCode"("shopId", "expiresAt");
CREATE INDEX "WalkInPhoneCode_shopId_lastSentAt_idx"
  ON "WalkInPhoneCode"("shopId", "lastSentAt");

ALTER TABLE "WalkInPhoneCode" ADD CONSTRAINT "WalkInPhoneCode_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* A negative attempt count or send count would mean the CAS guards above it
   were bypassed; refuse the row rather than trust the caller. */
ALTER TABLE "WalkInPhoneCode" ADD CONSTRAINT "WalkInPhoneCode_attempts_check"
  CHECK ("attemptCount" >= 0 AND "sendCount" >= 1);

/* ------------------------------------------------------------------ */
/* RLS: same tenant isolation as the other walk-in tables. The public  */
/* kiosk routes run as the connection owner (the waitlist-join trust   */
/* model); the policy is the defense-in-depth layer for everything     */
/* that ever reads this through runWithShop.                           */
/* ------------------------------------------------------------------ */

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chairback_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "WalkInPhoneCode" TO chairback_app';
  END IF;
END
$$;

ALTER TABLE "WalkInPhoneCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalkInPhoneCode" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "WalkInPhoneCode";
CREATE POLICY tenant_isolation ON "WalkInPhoneCode"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
