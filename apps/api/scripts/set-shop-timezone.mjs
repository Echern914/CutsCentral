/**
 * TEMPORARY test helper — set ONE shop's timezone by id.
 *
 * Used to bypass TCPA quiet hours during a live SMS test at night: flip the
 * test shop to a zone where it's currently daytime, send the test text, then
 * flip it BACK. Writes exactly one row (the shop you name). Nothing else.
 *
 *   node apps/api/scripts/set-shop-timezone.mjs --shop <id> --tz Asia/Tokyo
 *
 * REMEMBER to restore the real timezone after the test — a wrong tz skews the
 * shop's booking slots and quiet-hours window.
 */
import { config } from "dotenv";
config();
import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

const url = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const shopId = arg("--shop");
const tz = arg("--tz");
if (!url || !shopId || !tz) {
  console.error("Usage: --shop <id> --tz <IANA zone>  (needs PROD_DATABASE_URL/DATABASE_URL)");
  process.exit(1);
}
// Validate the zone is real before writing (a bad tz would break slot math).
try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); }
catch { console.error(`Invalid timezone: ${tz}`); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
const main = async () => {
  const before = await prisma.shop.findUnique({ where: { id: shopId }, select: { name: true, timezone: true } });
  if (!before) { console.error(`No shop ${shopId}`); process.exit(1); }
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: tz } });
  const localHour = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date());
  console.log(`${before.name}: timezone ${before.timezone} -> ${tz}  (now ${localHour}:00 local there)`);
};
main().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
