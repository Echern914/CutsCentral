/* A BROADCAST CAN BE AIMED AT CLIENTS WHO HAD A SERVICE.

   audienceServiceKeys: empty = no service filter (every existing row). Otherwise
   `id:<serviceId>` for the shop's menu, or `name:<lower-cased name>` for a synced
   name that matches no menu item. Resolved to client ids inside the locked
   freeze, like the tiers.
   audienceServiceLabels: the names the barber saw, in the same order, so the
   history survives a rename.
   audienceSinceDays: only visits in the last N days count; null = any time.

   Additive only: three new columns with defaults, nothing read or rewritten. */

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "audienceServiceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "audienceServiceLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "audienceSinceDays" INTEGER;
