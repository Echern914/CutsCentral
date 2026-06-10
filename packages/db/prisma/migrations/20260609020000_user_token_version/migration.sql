-- Session revocation: tokens embed the version they were minted with; bumping
-- the column on password change invalidates every previously issued token.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
