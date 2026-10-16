import { Prisma, runWithShop } from "@chairback/db";
import { nameKey } from "./acuityServiceImport.js";

/**
 * SEVERAL SERVICES AT ONCE - a menu pasted from another app (Booksy, TheCut,
 * Google), parsed and reviewed in the browser (config `parseServiceMenu`), then
 * saved here as the rows the barber kept.
 *
 * One transaction: every service is created, or none. Under the same per-shop
 * lock as the Acuity service import, so a second tap on Save, a second tab, or
 * an import running at the same moment finds the first one's services already
 * there and skips them by name - never a duplicate menu.
 *
 * Only ever adds. A name already on the menu (an active service, matched the
 * way the Acuity import matches: trimmed, spaces collapsed, case ignored) is
 * skipped and reported, never overwritten.
 */
export interface BulkServiceRow {
  name: string;
  durationMin: number;
  /** Dollars; null = no price shown. */
  price: number | null;
  description?: string;
}

export interface BulkServiceResult {
  created: { id: string; name: string }[];
  /** Names left alone because the menu already has them (or the paste repeated them). */
  skipped: string[];
}

/** The highest sortOrder the service form accepts. */
const SORT_MAX = 1000;

export async function createServicesInBulk(shopId: string, rows: BulkServiceRow[]): Promise<BulkServiceResult> {
  return runWithShop(
    shopId,
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`svcimport:${shopId}`}))`);
      const existing = await tx.service.findMany({
        where: { shopId, active: true },
        select: { name: true, sortOrder: true },
      });
      const taken = new Set(existing.map((s) => nameKey(s.name)));
      // After everything already on the menu, in the order they were pasted:
      // rows written in one transaction can share a createdAt.
      let sortOrder = existing.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;

      const staff = await tx.staff.findMany({ where: { shopId, active: true }, select: { id: true } });
      const created: { id: string; name: string }[] = [];
      const skipped: string[] = [];
      for (const row of rows) {
        const key = nameKey(row.name);
        if (!key || taken.has(key)) {
          skipped.push(row.name);
          continue;
        }
        taken.add(key);
        const service = await tx.service.create({
          data: {
            shopId,
            name: row.name.replace(/\s+/g, " ").trim(),
            description: row.description?.trim() || null,
            durationMin: row.durationMin,
            price: row.price,
            sortOrder: Math.min(sortOrder++, SORT_MAX),
            // Same as Add service with no one picked: every active staff member
            // now, and anyone added later.
            offeredByAll: true,
          },
          select: { id: true, name: true },
        });
        if (staff.length > 0) {
          await tx.serviceStaff.createMany({
            data: staff.map((s) => ({ shopId, serviceId: service.id, staffId: s.id })),
          });
        }
        created.push(service);
      }
      return { created, skipped };
    },
    // A long menu is a couple of hundred writes; the 5s default is too tight
    // against a remote database.
    { timeout: 30_000 },
  );
}
