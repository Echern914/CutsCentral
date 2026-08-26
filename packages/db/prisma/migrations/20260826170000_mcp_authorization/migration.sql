-- Remote MCP server: authorization, tokens and audit.
--
-- ADDITIVE AND INERT. Seven new tables, four new enums, two new relation fields.
-- No existing table is altered, no row is backfilled, and nothing here changes
-- behaviour for any shop: the MCP endpoints refuse every request until a human
-- completes an authorization, and no shop has one on merge.
--
-- Every statement is IF NOT EXISTS / duplicate-object guarded, so applying this
-- twice is a no-op (proven in CI by running `migrate deploy` twice).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "McpProviderHint" AS ENUM ('CHATGPT', 'CLAUDE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "McpAccessLevel" AS ENUM ('READ_ONLY', 'MANAGEMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "McpOperationType" AS ENUM ('READ', 'WRITE', 'AUTH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "McpAuditResult" AS ENUM ('OK', 'DENIED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- McpClient - a self-registered public client (RFC 7591)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpClient" (
    "id"           TEXT NOT NULL,
    "clientId"     TEXT NOT NULL,
    "clientName"   TEXT NOT NULL,
    "redirectUris" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "providerHint" "McpProviderHint" NOT NULL DEFAULT 'OTHER',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt"   TIMESTAMP(3),
    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "McpClient_clientId_key" ON "McpClient"("clientId");
CREATE INDEX IF NOT EXISTS "McpClient_createdAt_idx" ON "McpClient"("createdAt");

-- ---------------------------------------------------------------------------
-- McpAuthCode - one single-use code, alive for seconds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpAuthCode" (
    "id"               TEXT NOT NULL,
    "codeHash"         TEXT NOT NULL,
    "clientId"         TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "shopId"           TEXT NOT NULL,
    "codeChallenge"    TEXT NOT NULL,
    "redirectUri"      TEXT NOT NULL,
    "resource"         TEXT NOT NULL,
    "scopes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "accessLevel"      "McpAccessLevel" NOT NULL DEFAULT 'READ_ONLY',
    "expiresAt"        TIMESTAMP(3) NOT NULL,
    "consumedAt"       TIMESTAMP(3),
    "replayDetectedAt" TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuthCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "McpAuthCode_codeHash_key" ON "McpAuthCode"("codeHash");
CREATE INDEX IF NOT EXISTS "McpAuthCode_expiresAt_idx" ON "McpAuthCode"("expiresAt");
CREATE INDEX IF NOT EXISTS "McpAuthCode_userId_idx" ON "McpAuthCode"("userId");

-- ---------------------------------------------------------------------------
-- McpConnection - the durable grant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpConnection" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "shopId"        TEXT NOT NULL,
    "clientId"      TEXT NOT NULL,
    "accessLevel"   "McpAccessLevel" NOT NULL DEFAULT 'READ_ONLY',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"    TIMESTAMP(3),
    "revokedAt"     TIMESTAMP(3),
    "revokedReason" TEXT,
    CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id")
);
-- One live connection per (user, shop, client): re-authorizing reuses the row
-- instead of leaving the human a list of identical-looking grants.
CREATE UNIQUE INDEX IF NOT EXISTS "McpConnection_userId_shopId_clientId_key"
  ON "McpConnection"("userId", "shopId", "clientId");
CREATE INDEX IF NOT EXISTS "McpConnection_shopId_idx" ON "McpConnection"("shopId");
CREATE INDEX IF NOT EXISTS "McpConnection_revokedAt_idx" ON "McpConnection"("revokedAt");

-- ---------------------------------------------------------------------------
-- McpAccessToken / McpRefreshToken - hashes only, never plaintext
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpAccessToken" (
    "id"           TEXT NOT NULL,
    "tokenHash"    TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource"     TEXT NOT NULL,
    "scopes"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "revokedAt"    TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAccessToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "McpAccessToken_tokenHash_key" ON "McpAccessToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "McpAccessToken_connectionId_idx" ON "McpAccessToken"("connectionId");
CREATE INDEX IF NOT EXISTS "McpAccessToken_expiresAt_idx" ON "McpAccessToken"("expiresAt");

CREATE TABLE IF NOT EXISTS "McpRefreshToken" (
    "id"               TEXT NOT NULL,
    "tokenHash"        TEXT NOT NULL,
    "connectionId"     TEXT NOT NULL,
    "tokenFamily"      TEXT NOT NULL,
    "resource"         TEXT NOT NULL,
    "scopes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "expiresAt"        TIMESTAMP(3) NOT NULL,
    "rotatedAt"        TIMESTAMP(3),
    "revokedAt"        TIMESTAMP(3),
    "replayDetectedAt" TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpRefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "McpRefreshToken_tokenHash_key" ON "McpRefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "McpRefreshToken_connectionId_idx" ON "McpRefreshToken"("connectionId");
CREATE INDEX IF NOT EXISTS "McpRefreshToken_tokenFamily_idx" ON "McpRefreshToken"("tokenFamily");
CREATE INDEX IF NOT EXISTS "McpRefreshToken_expiresAt_idx" ON "McpRefreshToken"("expiresAt");

-- ---------------------------------------------------------------------------
-- McpToolGrant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpToolGrant" (
    "id"           TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "scope"        TEXT NOT NULL,
    "enabled"      BOOLEAN NOT NULL DEFAULT true,
    "grantedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"    TIMESTAMP(3),
    CONSTRAINT "McpToolGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "McpToolGrant_connectionId_scope_key"
  ON "McpToolGrant"("connectionId", "scope");
CREATE INDEX IF NOT EXISTS "McpToolGrant_connectionId_idx" ON "McpToolGrant"("connectionId");

-- ---------------------------------------------------------------------------
-- McpAuditEvent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "McpAuditEvent" (
    "id"            TEXT NOT NULL,
    "shopId"        TEXT NOT NULL,
    "userId"        TEXT,
    "connectionId"  TEXT,
    "toolName"      TEXT NOT NULL,
    "operationType" "McpOperationType" NOT NULL,
    "resourceType"  TEXT,
    "resourceId"    TEXT,
    "result"        "McpAuditResult" NOT NULL,
    "failureCode"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "McpAuditEvent_shopId_createdAt_idx" ON "McpAuditEvent"("shopId", "createdAt");
CREATE INDEX IF NOT EXISTS "McpAuditEvent_connectionId_createdAt_idx" ON "McpAuditEvent"("connectionId", "createdAt");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "McpAuthCode" ADD CONSTRAINT "McpAuthCode_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "McpAccessToken" ADD CONSTRAINT "McpAccessToken_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "McpRefreshToken" ADD CONSTRAINT "McpRefreshToken_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "McpToolGrant" ADD CONSTRAINT "McpToolGrant_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "McpAuditEvent" ADD CONSTRAINT "McpAuditEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- SET NULL, not CASCADE: deleting a connection must not erase the record of
-- what it did. The audit trail outlives the grant.
DO $$ BEGIN
  ALTER TABLE "McpAuditEvent" ADD CONSTRAINT "McpAuditEvent_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- 🔴 TWO DIFFERENT TREATMENTS, and the difference is deliberate.
--
-- (a) THE TOKEN TABLES (McpClient, McpAuthCode, McpConnection, McpAccessToken,
--     McpRefreshToken, McpToolGrant) get RLS enabled and NO policy and NO grant
--     to `chairback_app` - i.e. DEFAULT DENY for the application role. This is
--     the same treatment AcuityConnection and SquareConnection already have.
--
--     Why they cannot be ordinary tenant tables: resolving a bearer token is
--     how the shop is DISCOVERED. The lookup is `tokenHash -> connection ->
--     shopId`, which by definition runs before any shop context exists, so a
--     `shopId = current_shop_id()` policy would make every token unresolvable.
--     That is precisely the trap that made FORCE RLS on SquareConnection break
--     the Square webhook. Default-deny is strictly stronger here anyway: the
--     tenant-scoped role cannot read these tables AT ALL, so no amount of
--     confusion inside a runWithShop() transaction can leak a token hash.
--
-- (b) McpAuditEvent IS an ordinary tenant table - it is written after a shop is
--     known and read by the dashboard - so it gets the normal GRANT + ENABLE +
--     FORCE + tenant_isolation policy, identical to AcuityOutboundBlock.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'McpClient', 'McpAuthCode', 'McpConnection',
    'McpAccessToken', 'McpRefreshToken', 'McpToolGrant'
  ]
  LOOP
    -- Belt and braces: revoke anything inherited from PUBLIC before relying on
    -- the absence of a grant. A GRANT that was never issued is not the same as
    -- a privilege that was never held.
    EXECUTE format('REVOKE ALL ON %I FROM chairback_app;', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    -- No policy is created on purpose. RLS with zero policies denies every row
    -- to every non-owner role.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "McpAuditEvent" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['McpAuditEvent']
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

-- Expired codes and tokens are swept by a cron in a later PR; the lease row is
-- seeded now because a cron without one never runs in production, and that has
-- shipped dead once already (acuity-resync).
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('mcp-token-sweep', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
