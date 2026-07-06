-- Scale headroom for ~100 shops: index the query shapes that were doing
-- sequential/partial-table scans. IF NOT EXISTS keeps this idempotent if a
-- concurrent index was created out of band. Tables are small today, so plain
-- (non-CONCURRENT) builds lock only momentarily; revisit CONCURRENTLY if these
-- tables grow large before this ships.

-- Client.phone: inbound Twilio STOP/START (updateMany by phone, every inbound
-- SMS) and the public resolve-by-phone route both do a bare-phone lookup that
-- otherwise scans the whole cross-tenant Client table.
CREATE INDEX IF NOT EXISTS "Client_phone_idx" ON "Client"("phone");

-- Nudge attribution: the hourly job fetches SENT nudges by sentAt window; no
-- sentAt index existed, so the fetch degraded linearly with all-time sends.
CREATE INDEX IF NOT EXISTS "Nudge_status_sentAt_idx" ON "Nudge"("status", "sentAt");

-- Nudge "rebookings recovered this month" on /stats and /trends filters
-- (shopId, resultedInBookingAt) with no matching index.
CREATE INDEX IF NOT EXISTS "Nudge_shopId_resultedInBookingAt_idx" ON "Nudge"("shopId", "resultedInBookingAt");

-- Visit attribution booking lookup filters (shopId, clientId, createdAt) - the
-- existing (shopId, clientId, scheduledAt) index doesn't cover createdAt.
CREATE INDEX IF NOT EXISTS "Visit_shopId_clientId_createdAt_idx" ON "Visit"("shopId", "clientId", "createdAt");

-- Visit analytics shapes: insights weekly buckets, trends, avg-ticket aggregate,
-- and the activity feed all filter (shopId, status, scheduledAt) ranges.
CREATE INDEX IF NOT EXISTS "Visit_shopId_status_scheduledAt_idx" ON "Visit"("shopId", "status", "scheduledAt");
