/**
 * ENABLE THE OUTBOUND ACUITY MIRROR FOR ONE SHOP, ONE DELIBERATE STEP AT A TIME.
 *
 * Turning a shop ENFORCE makes its booking page FAIL CLOSED: if Acuity
 * definitively refuses a block (expired token, deleted calendar) that shop's
 * customers cannot book. That is the trade the feature exists to make - but it
 * means each step here is a decision, so each one is its own flag and every
 * flag defaults to off. With only a slug this script READS and writes nothing.
 *
 *   tsx scripts/acuity-mirror-enable.ts <slug> [flags]
 *
 *   (no flags)              shop, chairs, live calendars, and the rehearsal
 *   --set-primary=id        the chair's main Acuity calendar
 *   --set-extras=a,b,c      the other calendars this SAME chair is sold on
 *   --enforce               flip acuityOutboundMode to ENFORCE
 *   --backfill              write + dispatch blocks for existing bookings
 *   --verify                list the blocks that are actually on the account
 *   --rollback              THE UNDO: mode OFF + delete every block we created
 *
 * Run through `railway run` so prod env is injected; deliberately does NOT
 * import env-bootstrap, which would load the DEV .env instead.
 *
 * The order that has worked: read -> set-primary + set-extras -> read the
 * rehearsal line ("N bookings -> M blocks") -> --enforce --backfill --verify.
 */
import { createHash } from "node:crypto";
import { prisma } from "@chairback/db";
import { getAcuityClientForShop } from "../src/acuity/client.js";
import {
  getMappingSnapshot,
  setStaffCalendar,
  setStaffExtraCalendars,
} from "../src/engines/acuityCalendarMap.js";
import { buildObserveReport, releaseAllForShop } from "../src/engines/acuityMirror.js";
import { backfillShop } from "../src/engines/acuityBackfill.js";

const args = process.argv.slice(2);
// Named explicitly, never defaulted: this script can take a shop's booking
// page offline, and "which shop" must not be something it guesses.
const SLUG = args.find((a) => !a.startsWith("--")) ?? null;
const flag = (name: string) => args.some((a) => a === `--${name}`);
const value = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  if (!SLUG) {
    console.log("usage: acuity-mirror-enable.ts <shop-slug> [--set-primary=id] [--set-extras=a,b] [--enforce] [--backfill] [--verify] [--rollback]");
    return;
  }
  const [db] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    "SELECT current_database()",
  );
  console.log(
    "env:",
    process.env.RAILWAY_ENVIRONMENT_NAME,
    "| db:",
    db?.current_database,
    "| url sha:",
    createHash("sha256").update(process.env.DATABASE_URL ?? "").digest("hex").slice(0, 12),
  );

  const shop = await prisma.shop.findFirst({
    where: { slug: SLUG },
    select: { id: true, name: true, slug: true, bookingMode: true, acuityOutboundMode: true },
  });
  if (!shop) {
    console.log(`NO SHOP with slug ${SLUG}`);
    return;
  }
  console.log("shop:", JSON.stringify(shop));

  const snap = await getMappingSnapshot(shop.id);
  console.log(
    "live calendars:",
    JSON.stringify(snap.calendars.map((c) => ({ id: c.id, name: c.name }))),
  );
  const staff = await prisma.staff.findMany({
    where: { shopId: shop.id },
    select: {
      id: true,
      name: true,
      active: true,
      acuityCalendarId: true,
      acuityExtraCalendarIds: true,
    },
    orderBy: { sortOrder: "asc" },
  });
  console.log("chairs:", JSON.stringify(staff));
  console.log("readiness.ready:", snap.readiness.ready);
  console.log("readiness.blocking:", JSON.stringify(snap.readiness.blocking.map((s) => s.problem)));

  //  Step 0: the chair's main calendar

  const primary = value("set-primary");
  if (primary !== null) {
    const bookable = snap.readiness.staff.filter((s) => s.bookable);
    if (bookable.length !== 1) {
      console.log(`REFUSED: expected exactly one bookable chair, found ${bookable.length}`);
      return;
    }
    await setStaffCalendar(shop.id, bookable[0]!.id, primary, snap.connectedAt);
    console.log(`primary saved: ${bookable[0]!.name} -> ${primary}`);
  }

  //  Step 1: the other calendars this chair is sold on

  const extras = value("set-extras");
  if (extras !== null) {
    const bookable = snap.readiness.staff.filter((s) => s.bookable);
    if (bookable.length !== 1) {
      console.log(`REFUSED: expected exactly one bookable chair, found ${bookable.length}`);
      return;
    }
    const ids = extras.split(",").map((s) => s.trim()).filter(Boolean);
    await setStaffExtraCalendars(shop.id, bookable[0]!.id, ids, snap.connectedAt);
    const after = await prisma.staff.findUnique({
      where: { id: bookable[0]!.id },
      select: { acuityCalendarId: true, acuityExtraCalendarIds: true },
    });
    console.log("extras saved:", JSON.stringify(after));
  }

  //  The rehearsal: exactly what ENFORCE would do, with zero writes

  const report = await buildObserveReport(shop.id, new Date(), 90);
  const blocks = report.wouldCreate.reduce((n, w) => n + w.calendarIds.length, 0);
  console.log(
    `rehearsal: ${report.wouldCreate.length} bookings -> ${blocks} blocks`,
    JSON.stringify(
      report.wouldCreate.slice(0, 10).map((w) => ({
        startsAt: w.startsAt,
        calendars: w.calendarIds.length,
        blocked: w.blocked,
        reason: w.reason,
      })),
    ),
  );
  console.log("unmapped staff:", JSON.stringify(report.unmappedStaff));

  //  The undo: stop mirroring AND take back every block we created

  if (flag("rollback")) {
    await prisma.shop.update({ where: { id: shop.id }, data: { acuityOutboundMode: "OFF" } });
    const released = await releaseAllForShop(shop.id);
    console.log(`rollback: mode -> OFF, ${released} blocks released`);
    return;
  }

  //  Step 2: the mode

  if (flag("enforce")) {
    const fresh = await getMappingSnapshot(shop.id);
    if (!fresh.readiness.ready) {
      console.log("REFUSED: mapping is not ready - ENFORCE would half-protect the shop");
      return;
    }
    await prisma.shop.update({
      where: { id: shop.id },
      data: { acuityOutboundMode: "ENFORCE" },
    });
    console.log("mode -> ENFORCE");
  }

  //  Step 3: everything already on the books

  if (flag("backfill")) {
    let cursor: { startsAt: string; id: string } | null = null;
    let round = 0;
    for (;;) {
      const run = await backfillShop(shop.id, { limit: 25, cursor: cursor ?? undefined });
      round += 1;
      console.log(
        `backfill round ${round}:`,
        JSON.stringify({
          scanned: run.scanned,
          created: run.created,
          active: run.active,
          unknown: run.unknown,
          failed: run.failed,
          skippedProtected: run.skippedProtected,
          skippedBlocked: run.skippedBlocked,
          skippedIneligible: run.skippedIneligible,
          done: run.done,
        }),
      );
      if (run.done || round >= 20) break;
      cursor = run.nextCursor;
    }
  }

  //  Step 4: what is ACTUALLY on the barber's Acuity account

  if (flag("verify")) {
    const acuity = await getAcuityClientForShop(shop.id);
    const now = new Date();
    const live = await acuity.listBlocks({
      minDate: ymd(now),
      maxDate: ymd(new Date(now.getTime() + 90 * DAY)),
      max: 100,
    });
    const ours = live.filter((b) =>
      String(b.notes ?? b.description ?? "").startsWith("ChairBack ref "),
    );
    console.log(`acuity blocks in the next 90d: ${live.length}, ours: ${ours.length}`);
    console.log(
      JSON.stringify(
        ours.slice(0, 20).map((b) => ({
          cal: b.calendarID ?? null,
          start: b.start ?? b.startTime ?? null,
          end: b.end ?? b.endTime ?? null,
        })),
      ),
    );
    const rows = await prisma.acuityOutboundBlock.groupBy({
      by: ["state"],
      where: { shopId: shop.id },
      _count: { _all: true },
    });
    console.log("outbox:", JSON.stringify(rows.map((r) => [r.state, r._count._all])));
  }
}

main()
  .catch((err) => console.log("FAILED:", (err as Error).name, (err as Error).message))
  .finally(() => prisma.$disconnect());
