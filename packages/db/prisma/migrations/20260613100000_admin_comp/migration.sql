-- Platform admin flag + comped access. Additive-only; defaults are the
-- pre-existing behavior (no admins, no comps), so deployed code is unaffected.

ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "compAccess" BOOLEAN NOT NULL DEFAULT false;
