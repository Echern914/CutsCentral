/* TWO SMALL FACTS ABOUT HOW A BUSINESS FOUND US.

   1. Shop.heardAbout: the owner's answer to "How did you hear about us?".
      NULL means not asked, which is every shop made before this. Not defaulted
      to 'other', because that would read as an answer nobody gave.

   2. AffiliateAccount.shortCode: a code a person can say out loud ("SNOW482").
      The 12-character `code` stays exactly as it is, because it is printed into
      links and QR codes that are already out in the world. Nullable on purpose:
      a row with no short code still works through its long code, and an account
      approved between this migration and the new API starting is not refused.

   🔴 NOTHING HERE MOVES MONEY. Re-running the backfill only touches rows that
   still have no short code. */

ALTER TABLE "Shop" ADD COLUMN "heardAbout" TEXT;
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_heardAbout_check" CHECK (
  "heardAbout" IS NULL OR "heardAbout" IN (
    'another_barber', 'instagram', 'tiktok', 'google', 'friend_family', 'other'
  )
);

ALTER TABLE "AffiliateAccount" ADD COLUMN "shortCode" TEXT;
CREATE UNIQUE INDEX "AffiliateAccount_shortCode_key" ON "AffiliateAccount"("shortCode");

/* Give each existing account a short code: up to five letters of its business
   name plus three digits, the same shape affiliateShortCodePrefix mints. A
   partner's code wins when one is typed at signup, so a candidate that matches
   one is skipped. After 50 tries the row stays NULL rather than failing a
   deploy: that account keeps its long code. */
DO $$
DECLARE
  acct RECORD;
  prefix TEXT;
  candidate TEXT;
  tries INT;
BEGIN
  FOR acct IN
    SELECT a."id", s."name"
    FROM "AffiliateAccount" a
    JOIN "Shop" s ON s."id" = a."shopId"
    WHERE a."shortCode" IS NULL
    ORDER BY a."createdAt"
  LOOP
    prefix := left(upper(regexp_replace(acct."name", '[^A-Za-z]', '', 'g')), 5);
    IF length(prefix) < 3 THEN
      prefix := 'SHOP';
    END IF;
    tries := 0;
    LOOP
      tries := tries + 1;
      EXIT WHEN tries > 50;
      candidate := prefix || (100 + floor(random() * 900))::int::text;
      IF NOT EXISTS (SELECT 1 FROM "AffiliateAccount" WHERE "shortCode" = candidate)
         AND NOT EXISTS (SELECT 1 FROM "Partner" WHERE "codeKey" = candidate) THEN
        UPDATE "AffiliateAccount" SET "shortCode" = candidate WHERE "id" = acct."id";
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END $$;
