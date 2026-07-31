-- Team seats: employee logins.
--
-- Until now every authenticated principal WAS the shop owner (Shop.ownerId) and
-- `Staff` was a calendar entity with a name and hours — there was no way for an
-- employee to sign in. ShopMember is the seat; TeamInvite is the one-shot,
-- hashed, expiring invitation that creates one.
--
-- Shop.ownerId REMAINS the source of truth for ownership. The OWNER member row
-- backfilled below is a mirror for uniform listing/UI, never the access check —
-- so this migration cannot lock an owner out of their own shop even if the
-- member table were empty or wrong.

CREATE TYPE "ShopRole" AS ENUM ('OWNER', 'MANAGER', 'BARBER');

CREATE TABLE "ShopMember" (
    "id"        TEXT NOT NULL,
    "shopId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "role"      "ShopRole" NOT NULL,
    "staffId"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamInvite" (
    "id"          TEXT NOT NULL,
    "shopId"      TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "role"        "ShopRole" NOT NULL,
    "staffId"     TEXT,
    "tokenHash"   TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "acceptedAt"  TIMESTAMP(3),
    "revokedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
);

-- One seat per person per shop; one person per chair.
CREATE UNIQUE INDEX "ShopMember_shopId_userId_key" ON "ShopMember"("shopId", "userId");
CREATE UNIQUE INDEX "ShopMember_staffId_key" ON "ShopMember"("staffId");
CREATE INDEX "ShopMember_userId_idx" ON "ShopMember"("userId");
CREATE UNIQUE INDEX "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");
CREATE INDEX "TeamInvite_shopId_email_idx" ON "TeamInvite"("shopId", "email");

ALTER TABLE "ShopMember" ADD CONSTRAINT "ShopMember_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopMember" ADD CONSTRAINT "ShopMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopMember" ADD CONSTRAINT "ShopMember_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing shop's owner gets their OWNER seat, so the Team page
-- lists the owner from day one. Idempotent via the unique (shopId, userId).
INSERT INTO "ShopMember" ("id", "shopId", "userId", "role", "createdAt", "updatedAt")
SELECT
    'sm_' || substr(md5(random()::text || s."id"), 1, 22),
    s."id",
    s."ownerId",
    'OWNER'::"ShopRole",
    now(),
    now()
FROM "Shop" s
ON CONFLICT ("shopId", "userId") DO NOTHING;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ShopMember" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TeamInvite" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ShopMember', 'TeamInvite']
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
