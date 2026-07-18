-- Account page plumbing: profile avatar + change-login-email tokens. The email
-- change flow is DARK until RESEND_API_KEY/EMAIL_FROM are set (mirrors
-- forgot-password) and the avatar column is nullable, so this migration
-- changes no runtime behavior on its own.

-- User: optional profile photo (https URL in the public storage bucket).
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

-- CreateTable: one-shot change-login-email tokens, emailed to the NEW address
-- to prove the owner controls it before it becomes the login identity. Only
-- the sha256 of the token is stored (tokenHash); the pending newEmail lives
-- here, not on User, so an unconfirmed request never affects login.
CREATE TABLE "EmailChangeToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeToken_tokenHash_key" ON "EmailChangeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailChangeToken_userId_idx" ON "EmailChangeToken"("userId");

-- AddForeignKey: cascade so deleting a user can never strand live tokens.
ALTER TABLE "EmailChangeToken" ADD CONSTRAINT "EmailChangeToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: non-tenant table (keyed to User, the global login identity). Enable RLS
-- with NO policy so the Supabase data API roles (anon/authenticated) are denied,
-- while the `postgres` owner the app connects as BYPASSES RLS and keeps full
-- access. Matches the PasswordResetToken lockdown. FORCE intentionally NOT used.
ALTER TABLE "EmailChangeToken" ENABLE ROW LEVEL SECURITY;
