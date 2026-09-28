import type { Prisma } from "@chairback/db";
import { serviceKey } from "./insightsWindow.js";

/**
 * "SEND IT TO EVERYONE WHO HAD A BEARD TRIM" - who that is.
 *
 * A broadcast aimed at services stores KEYS, the same shape Insights groups by
 * (serviceKey): `id:<serviceId>` for the shop's own menu, `name:<lower-cased
 * name>` for a synced name that matches nothing on the menu. The keys are
 * turned into client ids here, with an explicit shopId on every query, and
 * that set is handed to splitAudience as the group. The freeze calls this
 * again inside its own locked transaction, so the send never trusts a list the
 * preview worked out earlier.
 *
 * WHAT "HAD THE SERVICE" MEANS (decisions the owner can change):
 *   - a COMPLETED native appointment, or a COMPLETED synced visit, started in
 *     the window (any time, or the last N days); OR
 *   - an upcoming one still booked (native BOOKED, synced SCHEDULED or
 *     RESCHEDULED) - whatever the window, because a client booked in for it is
 *     plainly one of its clients.
 *   - No-shows, cancellations, pending requests and slot holds never count.
 *
 * HOW A VISIT IS MATCHED, the Insights service filter's rule:
 *   - a native appointment by its serviceId - the only reliable link;
 *   - a synced visit (no appointment behind it) by its free-text name, trimmed
 *     and lower-cased, equal to the menu item's name - or to the synced name
 *     picked. Never a substring: "Cut" must not pull in "Haircut & beard".
 *   - A visit promoted FROM a native appointment is skipped (appointment:
 *     null): its name was frozen at the time, and the appointment above
 *     already stands for it.
 *   - A visit with no name (every Square visit today) matches nothing.
 *
 * Grouped and distinct queries only - a shop can hold tens of thousands of
 * visits, and none of them has to leave the database as a row.
 */

/** The window choices the composer offers. null = any time. */
export const SINCE_DAYS = [90, 365] as const;
export type SinceDays = (typeof SINCE_DAYS)[number] | null;

const DAY_MS = 86_400_000;

/** One entry in the "By service" list. */
export interface ServiceOption {
  key: string;
  label: string;
  /** menu = the shop's own service; synced = a name only its old system used. */
  source: "menu" | "synced";
  /** Current (non-archived) clients who had it, in this window. */
  clients: number;
}

/** Which native appointments and synced visits count as having had a service. */
function hadIt(now: Date, sinceDays: SinceDays) {
  const since = sinceDays === null ? undefined : new Date(now.getTime() - sinceDays * DAY_MS);
  const native: Prisma.AppointmentWhereInput = {
    holdExpiresAt: null,
    clientId: { not: null },
    OR: [
      { status: "COMPLETED", ...(since ? { startsAt: { gte: since } } : {}) },
      { status: "BOOKED", startsAt: { gte: now } },
    ],
  };
  const synced: Prisma.VisitWhereInput = {
    appointment: null,
    serviceName: { not: null },
    OR: [
      { status: "COMPLETED", noShow: false, ...(since ? { scheduledAt: { gte: since } } : {}) },
      { status: { in: ["SCHEDULED", "RESCHEDULED"] }, scheduledAt: { gte: now } },
    ],
  };
  return { native, synced };
}

/** The comparable form of a synced name, or null for a blank one. */
function nameOf(raw: string | null): string | null {
  const key = serviceKey({ serviceId: null, serviceName: raw });
  return key.startsWith("name:") ? key.slice("name:".length) : null;
}

/**
 * Check a pick against THIS shop and name it. An `id:` key must be one of the
 * shop's own services - another shop's id, or a made-up one, is refused rather
 * than quietly matching nobody. Labels come from the database, not the request:
 * the service's name now, or the synced spelling as it was written.
 */
export async function labelServiceKeys(
  tx: Prisma.TransactionClient,
  shopId: string,
  keys: readonly string[],
): Promise<{ ok: true; labels: string[] } | { ok: false }> {
  const ids = keys.filter((k) => k.startsWith("id:")).map((k) => k.slice(3));
  const menu = ids.length
    ? await tx.service.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const menuName = new Map(menu.map((m) => [m.id, m.name]));
  const wantsNames = keys.some((k) => k.startsWith("name:"));
  const synced = wantsNames
    ? await tx.visit.groupBy({ by: ["serviceName"], where: { shopId, serviceName: { not: null } } })
    : [];
  const spelling = new Map<string, string>();
  for (const v of synced) {
    const n = nameOf(v.serviceName);
    if (n !== null && !spelling.has(n)) spelling.set(n, v.serviceName!.trim());
  }
  const labels: string[] = [];
  for (const k of keys) {
    if (k.startsWith("id:")) {
      const name = menuName.get(k.slice(3));
      if (name === undefined) return { ok: false };
      labels.push(name);
    } else if (k.startsWith("name:") && k.length > 5) {
      labels.push(spelling.get(k.slice(5)) ?? k.slice(5));
    } else {
      return { ok: false };
    }
  }
  return { ok: true, labels };
}

/**
 * The client ids who had any of these services. Unknown and other-shop ids
 * match nothing here as well (the where carries shopId), so a stored key can
 * never reach across shops even if it got past the route.
 */
export async function serviceAudienceMembers(
  tx: Prisma.TransactionClient,
  shopId: string,
  keys: readonly string[],
  sinceDays: SinceDays,
  now: Date,
): Promise<Set<string>> {
  const { native, synced } = hadIt(now, sinceDays);
  const ids = keys.filter((k) => k.startsWith("id:")).map((k) => k.slice(3));
  const menu = ids.length
    ? await tx.service.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, name: true } })
    : [];
  // A blank name is never a pick: "no name" is not a service.
  const names = new Set<string>(
    keys.filter((k) => k.startsWith("name:")).map((k) => k.slice(5)).filter((n) => n !== ""),
  );
  for (const m of menu) {
    const n = nameOf(m.name);
    if (n !== null) names.add(n);
  }

  const members = new Set<string>();
  if (menu.length) {
    const rows = await tx.appointment.findMany({
      where: { ...native, shopId, serviceId: { in: menu.map((m) => m.id) } },
      select: { clientId: true },
      distinct: ["clientId"],
    });
    for (const r of rows) if (r.clientId) members.add(r.clientId);
  }
  if (names.size) {
    // The distinct spellings first, then the clients under the ones that match:
    // "Beard Trim" and "beard trim " are one service.
    const spellings = await tx.visit.groupBy({ by: ["serviceName"], where: { ...synced, shopId } });
    const matching = spellings
      .map((s) => s.serviceName)
      .filter((raw): raw is string => raw !== null && names.has(nameOf(raw) ?? ""));
    if (matching.length) {
      const rows = await tx.visit.findMany({
        // The rule first, so nothing in it can widen these two.
        where: { ...synced, shopId, serviceName: { in: matching } },
        select: { clientId: true },
        distinct: ["clientId"],
      });
      for (const r of rows) members.add(r.clientId);
    }
  }
  return members;
}

/**
 * The "By service" list: every service on the menu, and each synced name that
 * matches none of it, with how many current clients had it in this window.
 * A menu item switched off is listed only while somebody had it.
 */
export async function serviceAudienceOptions(
  tx: Prisma.TransactionClient,
  shopId: string,
  sinceDays: SinceDays,
  now: Date,
): Promise<ServiceOption[]> {
  const { native, synced } = hadIt(now, sinceDays);
  const [menu, nativePairs, syncedPairs] = await Promise.all([
    tx.service.findMany({
      where: { shopId },
      select: { id: true, name: true, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    // One row per (service, client) pair - never per appointment.
    tx.appointment.groupBy({
      by: ["serviceId", "clientId"],
      where: { ...native, shopId, client: { is: { archivedAt: null } } },
    }),
    tx.visit.groupBy({
      by: ["serviceName", "clientId"],
      where: { ...synced, shopId, client: { archivedAt: null } },
    }),
  ]);

  const byKey = new Map<string, Set<string>>();
  const add = (key: string, clientId: string | null) => {
    if (!clientId) return;
    const set = byKey.get(key) ?? new Set<string>();
    set.add(clientId);
    byKey.set(key, set);
  };
  // A synced name that equals a menu name belongs to that menu item (to every
  // one of that name - a shop can hold an inactive copy of a live service).
  const menuByName = new Map<string, string[]>();
  for (const m of menu) {
    const n = nameOf(m.name);
    if (n !== null) menuByName.set(n, [...(menuByName.get(n) ?? []), m.id]);
  }

  for (const p of nativePairs) add(`id:${p.serviceId}`, p.clientId);
  const syncedLabel = new Map<string, string>();
  for (const p of syncedPairs) {
    const n = nameOf(p.serviceName);
    if (n === null) continue;
    const onMenu = menuByName.get(n);
    if (onMenu) {
      for (const id of onMenu) add(`id:${id}`, p.clientId);
    } else {
      add(`name:${n}`, p.clientId);
      if (!syncedLabel.has(n)) syncedLabel.set(n, p.serviceName!.trim());
    }
  }

  const options: ServiceOption[] = [];
  for (const m of menu) {
    const clients = byKey.get(`id:${m.id}`)?.size ?? 0;
    if (m.active || clients > 0) options.push({ key: `id:${m.id}`, label: m.name, source: "menu", clients });
  }
  const fromSync = [...syncedLabel.entries()]
    .map(([n, label]) => ({ key: `name:${n}`, label, source: "synced" as const, clients: byKey.get(`name:${n}`)!.size }))
    .sort((a, b) => b.clients - a.clients || a.label.localeCompare(b.label));
  return [...options, ...fromSync];
}
