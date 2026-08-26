/**
 * WaitlistEntry.clientId coverage: how many entries resolved to a client, and
 * for the ones that did not, WHY.
 *
 * Read-only. Run against any environment - prod goes through `railway run`:
 *
 *   pnpm --filter @chairback/db report:waitlist-links
 *
 * An unlinked row is a row a Client-side ranking cannot see, so this is the
 * number that says whether such a ranking is worth adding. The reasons matter
 * more than the total: "no phone" is a shape of data nothing can fix, while
 * "ambiguous" is a pile of duplicate client records somebody could merge.
 *
 * The query is the same one the backfill migration reports at apply time
 * (20260825140000_waitlist_entry_client_id), which does not reliably surface
 * server notices through `prisma migrate deploy`.
 */
import { prisma } from "../src/client.js";

interface Row {
  total: bigint;
  linked: bigint;
  no_phone: bigint;
  no_match: bigint;
  ambiguous: bigint;
}

async function main(): Promise<void> {
  const [row] = await prisma.$queryRaw<Row[]>`
    SELECT
      count(*)                                                        AS total,
      count(*) FILTER (WHERE w."clientId" IS NOT NULL)                AS linked,
      count(*) FILTER (WHERE w."clientId" IS NULL
                         AND (w."phone" IS NULL OR w."phone" = ''))   AS no_phone,
      count(*) FILTER (WHERE w."clientId" IS NULL
                         AND w."phone" IS NOT NULL AND w."phone" <> ''
                         AND NOT EXISTS (
                           SELECT 1 FROM "Client" c
                           WHERE c."shopId" = w."shopId" AND c."phone" = w."phone"
                             AND c."archivedAt" IS NULL))             AS no_match,
      count(*) FILTER (WHERE w."clientId" IS NULL
                         AND w."phone" IS NOT NULL AND w."phone" <> ''
                         AND (SELECT count(*) FROM "Client" c
                              WHERE c."shopId" = w."shopId" AND c."phone" = w."phone"
                                AND c."archivedAt" IS NULL) > 1)      AS ambiguous
    FROM "WaitlistEntry" w
  `;
  if (!row) {
    console.log("no rows returned");
    return;
  }

  const n = (v: bigint): number => Number(v);
  const total = n(row.total);
  const pct = total === 0 ? "0.0" : ((n(row.linked) * 100) / total).toFixed(1);

  console.log(`WaitlistEntry rows        : ${total}`);
  console.log(`  linked to a client      : ${n(row.linked)} (${pct}%)`);
  console.log(`  unlinked, no phone      : ${n(row.no_phone)}`);
  console.log(`  unlinked, no live match : ${n(row.no_match)}`);
  console.log(`  unlinked, ambiguous     : ${n(row.ambiguous)}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
