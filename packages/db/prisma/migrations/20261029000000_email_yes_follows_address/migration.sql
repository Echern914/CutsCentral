/* A YES TO MARKETING EMAIL IS FOR ONE ADDRESS.

   Client.emailMarketingConsentAt records that a customer said yes to a shop's
   marketing email - for the address the record held when they said it. Many
   paths change a record's email afterwards: a hand edit, a merge filling a
   blank, a booking with a new address, group booking, the shop's own booking
   form, a claimed waitlist offer, an Acuity or Square sync. Without this, the
   yes stayed on the record, and a broadcast would go to the NEW address,
   which never said yes.

   So when a record's address changes, its yes is cleared - in the database,
   so every path that writes an email, today's and any added later, is
   covered without each one having to remember.

   What counts as a change is exactly what engines/broadcastAudience.ts
   emailAddressKey compares: trimmed, lower-cased, and empty means none.
     - The same address in a different case or with spaces around it is NOT a
       change: the yes stays.
     - A blank record getting an address IS a change: there was no address to
       have said yes for, so a yes left on a blank record is a leftover, and
       it must not switch on mail to whatever address arrives next.
     - An address removed IS a change.

   🔴 THE ONE EXCEPTION: an UPDATE that records a yes itself. A statement that
   fills in the address AND stamps the yes together is the customer saying
   yes for that new address, and clearing it would erase their answer. So the
   yes is cleared only when the same statement leaves it as it was.

   🔴 IT NEVER TOUCHES AN UNSUBSCRIBE (emailOptedOut, emailOptedOutAt) OR A
   BOUNCE (emailSuppressedAt, emailSuppressionReason). An unsubscribe is the
   person's decision and survives every email change.

   Nothing existing is rewritten: the trigger acts only on later UPDATEs.
   Reversible: drop the trigger and the two functions. */

/* The comparable form of an address, as emailAddressKey computes it:
   String.prototype.trim(), then toLowerCase(), then empty -> NULL.

   TRIM: exactly the 25 characters JavaScript's trim() removes (every Unicode
   code point checked in Node): tab, LF, VT, FF, CR, space, U+00A0, U+1680,
   U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. btrim with
   the same set removes the same characters from the same ends.

   🔴 LOWERCASE: A-Z ONLY, ON PURPOSE. JavaScript lower-cases ~1,460 non-ASCII
   letters by full Unicode rules. Postgres lower() follows the database's
   locale instead, and disagrees on several of them - for a Turkish dotted I it
   calls two addresses the SAME where JavaScript calls them different, which
   is the unsafe direction. lower(... COLLATE "und-x-icu") matches JavaScript
   but needs Postgres built with ICU, which a deploy cannot count on.

   Lower-casing only A-Z needs no locale and no ICU, and it can only err one
   way: whenever two addresses match here, they also match in JavaScript, so a
   yes is never kept across two different addresses. The cost is that a
   change of case in a NON-ASCII letter (JOSÉ@ -> josé@) reads as a new address
   and clears the yes. Rare, and it errs toward not sending. */
CREATE OR REPLACE FUNCTION client_email_address_key(email TEXT) RETURNS TEXT AS $fn$
  SELECT NULLIF(
    translate(
      btrim(
        email,
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      ),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    ),
    ''
  )
$fn$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION client_email_yes_follows_address() RETURNS trigger AS $fn$
BEGIN
  IF client_email_address_key(NEW."email") IS DISTINCT FROM client_email_address_key(OLD."email")
     AND NEW."emailMarketingConsentAt" IS NOT DISTINCT FROM OLD."emailMarketingConsentAt"
  THEN
    NEW."emailMarketingConsentAt" := NULL;
    NEW."emailMarketingConsentSource" := NULL;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- Fires only when the stored text actually changed; the function then asks
-- whether it is a different ADDRESS.
CREATE TRIGGER "Client_email_yes_follows_address"
  BEFORE UPDATE OF "email" ON "Client"
  FOR EACH ROW
  WHEN (OLD."email" IS DISTINCT FROM NEW."email")
  EXECUTE FUNCTION client_email_yes_follows_address();
