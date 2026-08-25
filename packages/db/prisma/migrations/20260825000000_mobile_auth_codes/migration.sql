-- One-shot codes that return a barber who authenticated in the system browser
-- back into the native app ("Join your shop"). Adds no behavior on its own: the
-- routes that mint and redeem these are new, and nothing else reads the table.

-- CreateTable. Only the sha256 of the code and of the app-generated state are
-- stored, so a DB leak yields nothing redeemable: the raw code lives for at
-- most two minutes, in one redirect, and dies on first use.
CREATE TABLE "MobileAuthCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'team_join',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the redeem path looks up by hash and nothing else.
CREATE UNIQUE INDEX "MobileAuthCode_codeHash_key" ON "MobileAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "MobileAuthCode_userId_idx" ON "MobileAuthCode"("userId");

-- CreateIndex: the sweep that deletes spent/expired rows scans by expiry.
CREATE INDEX "MobileAuthCode_expiresAt_idx" ON "MobileAuthCode"("expiresAt");

-- AddForeignKey: cascade so deleting a user can never strand a live code.
ALTER TABLE "MobileAuthCode" ADD CONSTRAINT "MobileAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: non-tenant table (keyed to User, the global login identity), so it gets
-- the same lockdown as PasswordResetToken - RLS ENABLED with NO policy, which
-- denies the Supabase data API roles outright while the `postgres` owner the app
-- connects as bypasses RLS. Deliberately NOT granted to chairback_app and
-- deliberately not FORCEd: this table is never read inside a tenant scope.
ALTER TABLE "MobileAuthCode" ENABLE ROW LEVEL SECURITY;
