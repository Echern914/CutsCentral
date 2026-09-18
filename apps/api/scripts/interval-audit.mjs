/**
 * Booking-integrity interval audit — READ ONLY, changes nothing.
 *
 * Counts malformed time spans and real overlaps so a repair can be argued from
 * numbers rather than fear. Aggregates only: no name, phone, email or row id is
 * selected, so the output is safe to paste into a PR.
 *
 * Run against PRODUCTION through the Railway env, never the local .env (which
 * points at dev and would answer confidently about the wrong database):
 *
 *   railway link --project <api project> --environment production --service <api>
 *   railway run node apps/api/scripts/interval-audit.mjs
 *
 * Findings as of 2026-09-17 are written up in
 * docs/booking-integrity-assessment.md.
 */
import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

const prisma = new PrismaClient();
const j = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 1);

const db = await prisma.$queryRaw`SELECT current_database() AS db`;
console.log("database:", j(db));

console.log("\n== Appointment spans (startsAt/endsAt, both NOT NULL) ==");
console.log(j(await prisma.$queryRaw`
  SELECT "status"::text AS status, COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "endsAt" = "startsAt")::int AS zero_length,
         COUNT(*) FILTER (WHERE "endsAt" < "startsAt")::int AS negative
  FROM "Appointment" GROUP BY "status" ORDER BY "status"`));

console.log("\n== Visit spans (endAt is the only nullable end) ==");
console.log(j(await prisma.$queryRaw`
  SELECT "status"::text AS status, COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "endAt" IS NULL)::int AS null_end,
         COUNT(*) FILTER (WHERE "endAt" = "scheduledAt")::int AS zero_length,
         COUNT(*) FILTER (WHERE "endAt" < "scheduledAt")::int AS negative
  FROM "Visit" GROUP BY "status" ORDER BY "status"`));

console.log("\n== Visit spans IN THE FUTURE (the only ones that can still double-book) ==");
console.log(j(await prisma.$queryRaw`
  SELECT "status"::text AS status, COUNT(*)::int AS future_total,
         COUNT(*) FILTER (WHERE "endAt" IS NULL)::int AS null_end,
         COUNT(*) FILTER (WHERE "endAt" = "scheduledAt")::int AS zero_length
  FROM "Visit" WHERE "scheduledAt" > now() GROUP BY "status" ORDER BY "status"`));

console.log("\n== Live future appointment pairs that OVERLAP on one chair ==");
console.log(j(await prisma.$queryRaw`
  SELECT COUNT(*)::int AS overlapping_pairs
  FROM "Appointment" a JOIN "Appointment" b
    ON a."staffId" = b."staffId" AND a."shopId" = b."shopId" AND a.id < b.id
   AND a."startsAt" < b."endsAt" AND b."startsAt" < a."endsAt"
  WHERE a."status" IN ('BOOKED','PENDING') AND b."status" IN ('BOOKED','PENDING')
    AND a."endsAt" > now()`));

console.log("\n== Pairs that merely TOUCH (half-open must NOT reject these) ==");
console.log(j(await prisma.$queryRaw`
  SELECT COUNT(*)::int AS touching_pairs
  FROM "Appointment" a JOIN "Appointment" b
    ON a."staffId" = b."staffId" AND a."shopId" = b."shopId" AND a.id <> b.id
   AND a."endsAt" = b."startsAt"
  WHERE a."status" IN ('BOOKED','PENDING') AND b."status" IN ('BOOKED','PENDING')`));

console.log("\n== Block tables ==");
console.log(j(await prisma.$queryRaw`
  SELECT 'ExternalBlock' AS t, COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "endsAt" <= "startsAt")::int AS invalid_span FROM "ExternalBlock"
  UNION ALL SELECT 'AvailabilityException', COUNT(*)::int,
         COUNT(*) FILTER (WHERE "endsAt" <= "startsAt")::int FROM "AvailabilityException"`));

await prisma.$disconnect();
