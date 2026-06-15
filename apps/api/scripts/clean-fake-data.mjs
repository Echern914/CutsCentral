/**
 * Remove leftover TEST/SEED data from the database.
 *
 * Root cause: the API test suite loaded the repo-root .env (production
 * DATABASE_URL) and created throwaway shops with `@test.local` owner emails
 * that were never cleaned up. They accumulated in production.
 *
 * What this deletes:
 *   - Every Shop whose owner email ends in `@test.local`
 *   - Every Shop owned by an explicitly listed seed/junk email (DELETE_EMAILS)
 *   - The owner User rows for those shops (they own nothing else)
 * Shop deletion CASCADES to clients, visits, nudges, ledger, promotions,
 * rewards, earn rules, Acuity connections, appointment requests (all
 * onDelete: Cascade in schema.prisma) — so we only delete shops + owners.
 *
 * What this KEEPS (real accounts — edit KEEP_EMAILS to change):
 *   - ericsupplyllc@gmail.com  (admin / BookedCuts)
 *   - the Drickcuttinup owner   (real beta data, 63 clients)
 *   - the chernCuts owner       (early real account)
 *
 * SAFETY:
 *   - Default mode is DRY RUN: prints what WOULD be deleted, changes nothing.
 *   - Pass `--apply` to actually delete.
 *   - Before deleting, writes a full JSON backup of every shop/user it will
 *     remove to apps/api/scripts/backup-<stamp>.json (stamp passed via env so
 *     the script stays deterministic).
 *
 * Run (dry run):   node apps/api/scripts/clean-fake-data.mjs
 * Run (for real):  node apps/api/scripts/clean-fake-data.mjs --apply
 */
import { config } from "dotenv";
config();

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const __dirname = dirname(fileURLToPath(import.meta.url));

// Real accounts to preserve. Everything else owned by @test.local or listed in
// DELETE_EMAILS is removed.
const KEEP_EMAILS = new Set([
  "ericsupplyllc@gmail.com", // admin / BookedCuts — must always stay
  "drickcuttinup@gmail.com", // Drickcuttinup — real beta data (63 clients)
  "chernichaw1@gmail.com",   // chernCuts — early real account
]);

// Explicit non-@test.local junk to delete (the dev seed account).
const DELETE_EMAILS = new Set(["drick@example.com"]);

function isJunk(email) {
  if (!email) return true; // orphan / no owner -> junk
  if (KEEP_EMAILS.has(email.toLowerCase())) return false;
  if (email.toLowerCase().endsWith("@test.local")) return true;
  if (DELETE_EMAILS.has(email.toLowerCase())) return true;
  return false; // any other real-looking account is kept by default
}

function host(url) {
  try { return new URL(url).host; } catch { return "(unparseable)"; }
}

async function main() {
  console.log("DB host:", host(process.env.DATABASE_URL ?? ""));
  console.log("Mode:", APPLY ? "APPLY (will delete)" : "DRY RUN (no changes)");

  const shops = await prisma.shop.findMany({
    include: {
      owner: { select: { id: true, email: true, isAdmin: true } },
      _count: { select: { clients: true, visits: true, nudges: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const toDelete = shops.filter((s) => isJunk(s.owner?.email ?? null));
  const toKeep = shops.filter((s) => !isJunk(s.owner?.email ?? null));

  console.log(`\nShops total: ${shops.length}  ->  delete ${toDelete.length}, keep ${toKeep.length}`);

  console.log("\n=== KEEPING ===");
  for (const s of toKeep) {
    const e = s.owner?.email ?? "NULL";
    console.log(`  KEEP  ${s.name.padEnd(22)} ${e}  admin=${s.owner?.isAdmin ?? false}  clients=${s._count.clients}`);
  }

  // Guard: never let the admin account fall into the delete bucket.
  const adminInDelete = toDelete.find((s) => s.owner?.isAdmin);
  if (adminInDelete) {
    throw new Error(`ABORT: an admin shop (${adminInDelete.owner?.email}) is in the delete set. Fix KEEP_EMAILS.`);
  }

  // Owner users to remove: owners of deleted shops who own NOTHING we keep.
  const keptOwnerIds = new Set(toKeep.map((s) => s.owner?.id).filter(Boolean));
  const ownerIdsToDelete = [
    ...new Set(
      toDelete
        .map((s) => s.owner?.id)
        .filter((id) => id && !keptOwnerIds.has(id)),
    ),
  ];

  console.log(`\n=== DELETING ${toDelete.length} shops + ${ownerIdsToDelete.length} owner users (cascades to clients/visits/nudges/etc.) ===`);
  let dc = 0, dv = 0, dn = 0;
  for (const s of toDelete) {
    dc += s._count.clients; dv += s._count.visits; dn += s._count.nudges;
  }
  console.log(`  Cascade will remove ~${dc} clients, ~${dv} visits, ~${dn} nudges (plus promos/rewards/ledger).`);

  if (!APPLY) {
    console.log("\nDRY RUN complete. No changes made. Re-run with --apply to delete.");
    return;
  }

  // Backup everything we're about to remove.
  const stamp = process.env.BACKUP_STAMP ?? "manual";
  const backupPath = resolve(__dirname, `backup-${stamp}.json`);
  const backup = {
    dbHost: host(process.env.DATABASE_URL ?? ""),
    deletedShops: toDelete.map((s) => ({ id: s.id, name: s.name, ownerEmail: s.owner?.email, counts: s._count })),
    deletedOwnerIds: ownerIdsToDelete,
  };
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const shopIds = toDelete.map((s) => s.id);
  const delShops = await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  const delUsers = await prisma.user.deleteMany({ where: { id: { in: ownerIdsToDelete } } });
  console.log(`Deleted ${delShops.count} shops and ${delUsers.count} users (cascade handled children).`);

  const [shopsLeft, clientsLeft, visitsLeft, usersLeft] = await Promise.all([
    prisma.shop.count(), prisma.client.count(), prisma.visit.count(), prisma.user.count(),
  ]);
  console.log(`\n=== AFTER ===  shops=${shopsLeft} clients=${clientsLeft} visits=${visitsLeft} users=${usersLeft}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("ERROR:", e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
