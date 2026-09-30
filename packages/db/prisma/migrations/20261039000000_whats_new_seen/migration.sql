-- "What's new" in the dashboard bell: the newest changelog entry each person
-- has seen (packages/config/src/whatsNew.ts). The bell marks every entry above
-- it as new. Nullable and additive: NULL means never opened, and the bell then
-- counts only what shipped since the account was created.
ALTER TABLE "User" ADD COLUMN "whatsNewSeenId" TEXT;
