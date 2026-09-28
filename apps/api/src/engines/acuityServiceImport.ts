import { SERVICE_COLORS, SERVICE_COLOR_KEYS, type ServiceColorKey } from "@chairback/config";
import { Prisma, runWithShop } from "@chairback/db";
import type { AcuityAppointmentType } from "../acuity/types.js";

/**
 * IMPORT SERVICES FROM ACUITY.
 *
 * A shop moving off Acuity had to retype its whole service menu by hand. This
 * reads the account's appointment types and creates the ones ChairBack does
 * not have yet, the way "Add service" does: offered by every active staff
 * member, with each Acuity category becoming a service group.
 *
 * It only ever ADDS. A service already in ChairBack - same name, ignoring case
 * and extra spaces - is never edited, so a service the owner set up by hand
 * keeps its own hours, prices and wording, and running the import a second
 * time adds nothing.
 *
 * What is left out, and why:
 *  - inactive types: the owner turned them off in Acuity;
 *  - private types: Acuity hides them from its public page, and a ChairBack
 *    service is public the moment it exists, so importing one would put it on
 *    the booking page. The preview lists them so they can be added by hand;
 *  - classes (anything Acuity does not call a plain "service"): ChairBack books
 *    one customer per time and has no class schedule;
 *  - a length ChairBack cannot book (the Add service form's own 5-600 range).
 */

export type ImportStatus =
  | "new"
  | "exists"
  | "duplicate"
  | "inactive"
  | "private"
  | "class"
  | "bad_length";

export interface ImportRow {
  acuityId: string;
  name: string;
  durationMin: number | null;
  price: number | null;
  category: string | null;
  status: ImportStatus;
}

export interface ImportPlan {
  rows: ImportRow[];
  /** Categories with no group yet that the "new" rows would create. */
  newGroups: string[];
}

interface Existing {
  services: { name: string; serviceGroupId: string | null }[];
  groups: { id: string; name: string }[];
}

/** The match rule: trimmed, spaces collapsed, case ignored. */
export function nameKey(name: string): string {
  return tidy(name).toLowerCase();
}

function tidy(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Acuity sends its flags as booleans, but tolerate "true"/"1" spellings. */
function flag(v: boolean | string | number | null | undefined): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  return v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure: what an import would do, given Acuity's types and what the shop
 * already has. The preview shows this; the import re-runs it inside its own
 * transaction, so the two can never use different rules.
 */
export function planServiceImport(
  types: AcuityAppointmentType[],
  existing: Existing,
): ImportPlan {
  const have = new Set(existing.services.map((s) => nameKey(s.name)));
  const haveGroup = new Set(existing.groups.map((g) => nameKey(g.name)));
  const planned = new Set<string>();
  const newGroups: string[] = [];

  // A type with no name has nothing to show or match on.
  const named = types.filter((t) => tidy(t.name).length > 0);
  const rows = named.map((t): ImportRow => {
    // Cut to the column's 120 first, so the name we compare is the name we store
    // - otherwise a long name would never match itself on the next run.
    const name = tidy(t.name).slice(0, 120);
    const durationMin = toNumber(t.duration);
    const rawPrice = toNumber(t.price);
    const price = rawPrice !== null && rawPrice >= 0 && rawPrice <= 100000 ? rawPrice : null;
    const category = tidy(t.category).slice(0, 120) || null;
    const classSize = toNumber(t.classSize) ?? 0;

    let status: ImportStatus;
    if (flag(t.active) === false) status = "inactive";
    else if ((t.type && t.type !== "service") || classSize > 1) status = "class";
    else if (have.has(nameKey(name))) status = "exists";
    else if (flag(t.private) === true) status = "private";
    else if (durationMin === null || !Number.isInteger(durationMin) || durationMin < 5 || durationMin > 600) {
      status = "bad_length";
    } else if (planned.has(nameKey(name))) status = "duplicate";
    else status = "new";

    if (status === "new") {
      planned.add(nameKey(name));
      if (category && !haveGroup.has(nameKey(category))) {
        haveGroup.add(nameKey(category));
        newGroups.push(category);
      }
    }
    return { acuityId: t.id, name, durationMin, price, category, status };
  });

  return { rows, newGroups };
}

/**
 * Acuity's description is HTML from its editor. Keep the words and the line
 * breaks, drop the markup: a service description here is plain text, shown
 * with its line breaks.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(#39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    // Last, so "&amp;lt;" becomes the literal "&lt;" rather than "<".
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hueOf(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/**
 * Acuity's colour, as one of ChairBack's calendar colours - only when it is
 * clearly that hue (within 30 degrees, and not grey, near-white or near-black).
 * Anything else saves no colour, and the calendar picks one from the name as
 * it does for every service without one.
 */
export function paletteKeyFor(hex: string | null | undefined): ServiceColorKey | null {
  const c = hex ? hueOf(hex) : null;
  if (!c || c.s < 0.25 || c.l < 0.15 || c.l > 0.92) return null;
  let best: ServiceColorKey | null = null;
  let bestGap = 30;
  for (const key of SERVICE_COLOR_KEYS) {
    if (key === "slate") continue; // the palette's grey: nothing with a hue maps to it
    const p = hueOf(SERVICE_COLORS[key].hex)!;
    const gap = Math.min(Math.abs(c.h - p.h), 360 - Math.abs(c.h - p.h));
    if (gap <= bestGap) {
      best = key;
      bestGap = gap;
    }
  }
  return best;
}

async function loadExisting(tx: Prisma.TransactionClient, shopId: string): Promise<Existing> {
  const [services, groups] = await Promise.all([
    // Active only: a removed service is gone from the owner's list, so it
    // does not count as "already in ChairBack".
    tx.service.findMany({
      where: { shopId, active: true },
      select: { name: true, serviceGroupId: true },
    }),
    tx.serviceGroup.findMany({
      where: { shopId, active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { services, groups };
}

/** The preview: Acuity's types marked against what the shop has now. Writes nothing. */
export async function previewServiceImport(
  shopId: string,
  types: AcuityAppointmentType[],
): Promise<ImportPlan> {
  const existing = await runWithShop(shopId, (tx) => loadExisting(tx, shopId));
  return planServiceImport(types, existing);
}

/**
 * The import, in ONE transaction: every group and service is created, or none.
 *
 * Only types the owner saw as "new" in the preview (`confirmedIds`) and that
 * are STILL new now are created - the plan is re-made under the lock, so a
 * service added in another tab meanwhile, or a second tap on Import, finds
 * everything already there and creates nothing.
 */
export async function applyServiceImport(
  shopId: string,
  types: AcuityAppointmentType[],
  confirmedIds: string[],
): Promise<{ created: number; groupsCreated: number }> {
  const byId = new Map(types.map((t) => [t.id, t]));
  const confirmed = new Set(confirmedIds);
  return runWithShop(
    shopId,
    async (tx) => {
      // One import per shop at a time: two racing imports must not both read
      // "not there yet" and both create the same service.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`svcimport:${shopId}`}))`);
      const existing = await loadExisting(tx, shopId);
      const plan = planServiceImport(types, existing);
      const toCreate = plan.rows.filter((r) => r.status === "new" && confirmed.has(r.acuityId));
      if (toCreate.length === 0) return { created: 0, groupsCreated: 0 };

      const staff = await tx.staff.findMany({
        where: { shopId, active: true },
        select: { id: true },
      });
      // First match wins if two groups share a name, like the first-created one.
      const groupIdByKey = new Map<string, string>();
      for (const g of existing.groups) {
        if (!groupIdByKey.has(nameKey(g.name))) groupIdByKey.set(nameKey(g.name), g.id);
      }
      // A service joining a group goes after the members it already has.
      const nextInGroup = new Map<string, number>();
      for (const s of existing.services) {
        if (s.serviceGroupId) {
          nextInGroup.set(s.serviceGroupId, (nextInGroup.get(s.serviceGroupId) ?? 0) + 1);
        }
      }

      let groupsCreated = 0;
      for (const row of toCreate) {
        let serviceGroupId: string | null = null;
        if (row.category) {
          serviceGroupId = groupIdByKey.get(nameKey(row.category)) ?? null;
          if (!serviceGroupId) {
            const group = await tx.serviceGroup.create({
              data: { shopId, name: row.category },
              select: { id: true },
            });
            serviceGroupId = group.id;
            groupIdByKey.set(nameKey(row.category), group.id);
            groupsCreated++;
          }
        }
        const groupSortOrder = serviceGroupId ? (nextInGroup.get(serviceGroupId) ?? 0) : 0;
        if (serviceGroupId) nextInGroup.set(serviceGroupId, groupSortOrder + 1);

        const type = byId.get(row.acuityId);
        const service = await tx.service.create({
          data: {
            shopId,
            name: row.name,
            description: htmlToPlainText(type?.description).slice(0, 800) || null,
            durationMin: row.durationMin!,
            price: row.price,
            color: paletteKeyFor(type?.color),
            // Same as Add service with no one picked: every active staff member
            // now, and anyone added later.
            offeredByAll: true,
            serviceGroupId,
            groupSortOrder,
          },
          select: { id: true },
        });
        if (staff.length > 0) {
          await tx.serviceStaff.createMany({
            data: staff.map((s) => ({ shopId, serviceId: service.id, staffId: s.id })),
          });
        }
      }
      return { created: toCreate.length, groupsCreated };
    },
    // A menu of 50+ services is ~100 writes; the 5s default is too tight
    // against a remote database.
    { timeout: 30_000 },
  );
}
