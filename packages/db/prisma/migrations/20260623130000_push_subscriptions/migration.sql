-- Web Push subscriptions: one row per installed-PWA device of a client. The
-- browser permission grant + this row ARE the push consent (independent of SMS
-- consent), powering the free, push-first leg of loyalty/rebooking sends.

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (one subscription per device endpoint; re-subscribe upserts on it)
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex (the send-path lookup: all subs for one client)
CREATE INDEX "PushSubscription_shopId_clientId_idx" ON "PushSubscription"("shopId", "clientId");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other tenant tables.
-- The send path (forShop -> SET ROLE chairback_app) is enforced; the public
-- subscribe/unsubscribe inserts run as the connection owner (no SET ROLE) and
-- bypass FORCE RLS, exactly like the rewards opt-in / appointment / review writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "PushSubscription" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PushSubscription']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
