-- Marketing-email suppressions bound to the ADDRESS they are about (#514).
--
-- Client.emailOptedOut and Client.emailSuppressedAt sit on a RECORD, and a
-- record's address changes - a booking with a new email, an Acuity or Square
-- sync, an import filling a blank. Kept only on the record, an old bounce
-- followed it onto its new, working address, and an unsubscribed address
-- became mailable again on any other record once the opted-out record moved
-- on (or was blanked by the customer deleting their data). This table names
-- the address instead.
--
-- Additive only: no existing column changes. The per-record flags stay, for
-- the person's own record and for the owner's screens.
--
-- 🔴 NEVER CLEARED by an email change, a sync, an import or a merge. Written
-- (and one day lifted) only in apps/api/src/services/emailSuppression.ts.
--
-- 🔴 NO ADDRESS IS STORED. addressHash is the sha256 hex of
-- `${shopId}:${suppressionAddressKey(address)}` - plain and shop-scoped, so
-- this backfill can compute it here with no secret.

CREATE TABLE "EmailAddressSuppression" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "addressHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "EmailAddressSuppression_pkey" PRIMARY KEY ("id")
);

/* One fact per address per kind: a repeat is a no-op (ON CONFLICT DO NOTHING),
   so the FIRST time it was seen is the time kept. */
CREATE UNIQUE INDEX "EmailAddressSuppression_shopId_addressHash_kind_key"
    ON "EmailAddressSuppression"("shopId", "addressHash", "kind");

ALTER TABLE "EmailAddressSuppression"
    ADD CONSTRAINT "EmailAddressSuppression_kind_check"
    CHECK ("kind" IN ('unsubscribe', 'bounce', 'complaint'));

ALTER TABLE "EmailAddressSuppression"
    ADD CONSTRAINT "EmailAddressSuppression_shopId_fkey" FOREIGN KEY ("shopId")
    REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant table ----------------------------------------------------------------

/* The shop's own list, like every other shop table. A shop session reads it
   to split an audience and writes it from a sync (runWithShop); the
   unsubscribe link and the provider webhook write it as the connection owner
   (runAsOwner), before any shop session exists. Nothing updates or deletes a
   row, so the app role is not granted either. */
GRANT SELECT, INSERT ON "EmailAddressSuppression" TO chairback_app;
REVOKE UPDATE, DELETE ON "EmailAddressSuppression" FROM chairback_app;
ALTER TABLE "EmailAddressSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailAddressSuppression" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EmailAddressSuppression";
CREATE POLICY tenant_isolation ON "EmailAddressSuppression"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

-- The hash, in SQL ------------------------------------------------------------

/* suppressionAddressHash() in apps/api/src/engines/broadcastAudience.ts, for
   the backfill below - the same steps, side by side:

     TypeScript                                  SQL
     email.replace(TRIM_EDGES, "")               btrim(email, <the same 25 code points>)
     .replace(/[A-Z]/g, c => c.toLowerCase())    translate(..., 'A..Z', 'a..z')
     key ? key : null                            NULL when ''
     sha256 hex of `${shopId}:${key}`            encode(sha256(convert_to(shop_id || ':' || key, 'UTF8')), 'hex')

   🔴 A-Z ONLY, on purpose. The app's emailAddressKey lower-cases with full
   Unicode rules (toLowerCase), which Postgres's lower() does not reproduce -
   it follows the database locale, and the dotted capital I, the Greek final
   sigma and others come out differently. Folding ASCII only is computed
   identically here and in the app for EVERY input; for an ASCII address it
   is exactly emailAddressKey. The 25 code points are exactly what
   String.prototype.trim() removes (ECMAScript WhiteSpace + LineTerminator).
   suppressionAddressHash.test.ts runs this function against the app's. */
CREATE OR REPLACE FUNCTION email_address_hash(shop_id text, email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN k IS NULL OR k = '' THEN NULL
    ELSE encode(sha256(convert_to(shop_id || ':' || k, 'UTF8')), 'hex')
  END
  FROM (SELECT translate(
    btrim(email,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) ||
      chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
      chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) ||
      chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS k) t
$$;

-- Backfill --------------------------------------------------------------------

/* Once, from today's flags, bound to each record's CURRENT address - the only
   address known, and the one the flags are already applied to. An unsubscribe
   is kept from when it was recorded; a bounce or complaint by its reason. */
INSERT INTO "EmailAddressSuppression" ("id", "shopId", "addressHash", "kind", "firstSeenAt", "source")
SELECT gen_random_uuid()::text, s."shopId", s."addressHash", s."kind", MIN(s."seenAt"), 'backfill'
  FROM (
    SELECT "shopId",
           email_address_hash("shopId", "email") AS "addressHash",
           'unsubscribe' AS "kind",
           COALESCE("emailOptedOutAt", CURRENT_TIMESTAMP) AS "seenAt"
      FROM "Client"
     WHERE "emailOptedOut"
    UNION ALL
    SELECT "shopId",
           email_address_hash("shopId", "email"),
           CASE WHEN "emailSuppressionReason" = 'complaint' THEN 'complaint' ELSE 'bounce' END,
           "emailSuppressedAt"
      FROM "Client"
     WHERE "emailSuppressedAt" IS NOT NULL
  ) s
 WHERE s."addressHash" IS NOT NULL
 GROUP BY s."shopId", s."addressHash", s."kind"
ON CONFLICT ("shopId", "addressHash", "kind") DO NOTHING;

/* Say what carried over, so a deploy log answers it. */
DO $$
DECLARE
  written integer;
  flagged integer;
BEGIN
  SELECT count(*) INTO written FROM "EmailAddressSuppression" WHERE "source" = 'backfill';
  SELECT count(*) INTO flagged
    FROM "Client"
   WHERE ("emailOptedOut" OR "emailSuppressedAt" IS NOT NULL)
     AND email_address_hash("shopId", "email") IS NOT NULL;
  RAISE NOTICE 'EmailAddressSuppression backfill: % rows written from % flagged records with an address',
    written, flagged;
END
$$;
