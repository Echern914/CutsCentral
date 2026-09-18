/**
 * Booking-integrity P0 — production verification reads. READ ONLY.
 *
 * Every statement here is a SELECT. Nothing is inserted, updated or deleted,
 * and no customer field (name, phone, email, price) is ever selected - counts,
 * ids, kinds and timestamps only, so output is safe to paste into a PR.
 *
 * Run against PRODUCTION through the Railway env, never a local .env (which
 * points at dev and would answer confidently about the wrong database):
 *
 *   railway run node apps/api/scripts/conflict-verify.mjs schema
 *   railway run node apps/api/scripts/conflict-verify.mjs baseline
 *   railway run node apps/api/scripts/conflict-verify.mjs conflicts <shopId>
 *
 * The procedure these back is docs/booking-conflict-production-verification.md.
 */
import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

const prisma = new PrismaClient();
const j = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 1);
const mode = process.argv[2];
const arg = process.argv[3];

const ok = (b) => (b ? "PASS" : "🔴 FAIL");

async function schema() {
  console.log("database:", j(await prisma.$queryRaw`SELECT current_database() AS db`));

  const col = await prisma.$queryRaw`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_name = 'Appointment' AND column_name = 'operationId'`;
  console.log("\n1. Appointment.operationId:", j(col));
  console.log("   present and NULLABLE:", ok(col.length === 1 && col[0].is_nullable === "YES"));

  // The index this whole design rests on. `indpred IS NOT NULL` is the only
  // honest test of "partial" - the migration file is not evidence of the
  // deployed state.
  const idx = await prisma.$queryRaw`
    SELECT c.relname AS name,
           pg_get_indexdef(i.indexrelid) AS ddl,
           (i.indpred IS NOT NULL) AS is_partial,
           i.indisunique AS is_unique
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname IN ('Appointment_shop_operation_key',
                        'BookingConflict_shop_receipt_other_key')
    ORDER BY c.relname`;
  console.log("\n2. indexes:", j(idx));
  const opIdx = idx.find((r) => r.name === "Appointment_shop_operation_key");
  console.log("   idempotency index UNIQUE + PARTIAL:", ok(opIdx?.is_unique && opIdx?.is_partial));
  // 🔴 NULLS NOT DISTINCT would make every legacy NULL row collide at once.
  console.log("   and NOT 'NULLS NOT DISTINCT':", ok(!/NULLS NOT DISTINCT/i.test(opIdx?.ddl ?? "")));
  const cIdx = idx.find((r) => r.name === "BookingConflict_shop_receipt_other_key");
  console.log(
    "   conflict key includes conflictingKind:",
    ok(/conflictingKind/.test(cIdx?.ddl ?? "")),
  );

  const rls = await prisma.$queryRaw`
    SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
           (SELECT COUNT(*)::int FROM pg_policies p
             WHERE p.tablename = 'BookingConflict') AS policies
    FROM pg_class c WHERE c.relname = 'BookingConflict'`;
  console.log("\n3. BookingConflict RLS:", j(rls));
  console.log(
    "   enabled + forced + >=1 policy:",
    ok(rls[0]?.enabled && rls[0]?.forced && rls[0]?.policies >= 1),
  );

  // The column that was deliberately NOT added: a preference nothing could
  // write is a preference in name only.
  const pref = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'BarberNotifyPref' AND column_name = 'conflictEnabled'`;
  console.log("\n4. BarberNotifyPref.conflictEnabled absent:", ok(pref[0].n === 0));
}

async function baseline() {
  console.log("database:", j(await prisma.$queryRaw`SELECT current_database() AS db`));
  // The expand-only claim, checked against real rows: every appointment that
  // existed before this deploy must still carry NULL.
  console.log(
    "\nAppointment totals:",
    j(await prisma.$queryRaw`
      SELECT COUNT(*)::int AS total,
             COUNT("operationId")::int AS with_operation_id,
             COUNT(*) FILTER (WHERE "operationId" IS NULL)::int AS legacy_null
      FROM "Appointment"`),
  );
  console.log(
    "\nBookingConflict totals:",
    j(await prisma.$queryRaw`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE "resolvedAt" IS NULL)::int AS open
      FROM "BookingConflict"`),
  );
  console.log(
    "\nConflicts by kind and source (no ids, fleet-wide shape only):",
    j(await prisma.$queryRaw`
      SELECT "conflictingKind", "source", COUNT(*)::int AS n
      FROM "BookingConflict" GROUP BY 1, 2 ORDER BY 1, 2`),
  );
}

async function conflicts(shopId) {
  if (!shopId) {
    console.error("usage: conflict-verify.mjs conflicts <shopId>");
    process.exitCode = 1;
    return;
  }
  // Scoped to ONE shop on purpose: this is run against a dedicated fixture, and
  // a fleet-wide dump of other shops' conflicts is not what is being verified.
  console.log(
    "walk-in receipts on this shop:",
    j(await prisma.$queryRaw`
      SELECT COUNT(*)::int AS receipts,
             COUNT("operationId")::int AS with_operation_id,
             COUNT(DISTINCT "operationId")::int AS distinct_operation_ids
      FROM "Appointment"
      WHERE "shopId" = ${shopId} AND "firstName" = 'Walk-in'`),
  );
  console.log(
    "\nconflict rows on this shop:",
    j(await prisma.$queryRaw`
      SELECT "id", "receiptId", "conflictingId", "conflictingKind", "source",
             "overlapStart", "overlapEnd", "detectedAt", "resolvedAt"
      FROM "BookingConflict"
      WHERE "shopId" = ${shopId}
      ORDER BY "detectedAt" DESC LIMIT 20`),
  );
  console.log(
    "\n🔴 duplicate check - any (receipt, kind, id) recorded more than once:",
    j(await prisma.$queryRaw`
      SELECT "receiptId", "conflictingKind", "conflictingId", COUNT(*)::int AS n
      FROM "BookingConflict" WHERE "shopId" = ${shopId}
      GROUP BY 1, 2, 3 HAVING COUNT(*) > 1`),
  );
}

try {
  if (mode === "schema") await schema();
  else if (mode === "baseline") await baseline();
  else if (mode === "conflicts") await conflicts(arg);
  else {
    console.error("usage: conflict-verify.mjs <schema|baseline|conflicts <shopId>>");
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
