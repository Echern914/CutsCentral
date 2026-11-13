import type { Prisma } from "@chairback/db";
import { serviceAudienceMembers, serviceAudienceOptions } from "./broadcastServices.js";

/**
 * "EVERYONE WHO BOOKED RETWISTS IN THE LAST 90 DAYS" - the Clients list filter.
 *
 * Who counts is NOT decided here. It is the same rule a message aimed "By
 * service" uses (engines/broadcastServices.ts): a finished visit in the window,
 * or one still booked whatever the window; no-shows, cancellations and holds
 * never; a synced visit matched by its exact name. One rule, so the list a
 * barber filters and the people a message to "Retwist clients" reaches can
 * never disagree.
 *
 * What this adds is a GROUP pick. A shop that sells one thing as several menu
 * items ("Retwist + cut", "Cornrows + cut", one group) asks about the group,
 * so `group:<id>` stands for every service in it.
 */

/** The windows the filter offers, in days. null = any time. */
export const CLIENT_SERVICE_WINDOWS = [30, 90, 365] as const;
export type ClientServiceWindow = (typeof CLIENT_SERVICE_WINDOWS)[number] | null;

/** What a pick with no window (or one this list does not offer) means: the page shows the same. */
export const DEFAULT_CLIENT_SERVICE_WINDOW = 90;

/** `?within=` as sent by the page: "30" | "90" | "365" | "any". Missing or unknown is 90 days. */
export function parseWithin(raw: unknown): ClientServiceWindow {
  if (raw === "any") return null;
  return CLIENT_SERVICE_WINDOWS.find((d) => String(d) === String(raw)) ?? DEFAULT_CLIENT_SERVICE_WINDOW;
}

/** One entry in the filter's list. */
export interface ClientServiceOption {
  key: string;
  label: string;
  /** group = a service group (every service in it); menu = one service; synced = a name only the old system used. */
  kind: "group" | "menu" | "synced";
}

/**
 * The service keys one pick stands for, checked against THIS shop. A group
 * becomes its own services (another shop's group id finds none). A malformed
 * key stands for nothing, so it filters the list to nobody rather than being
 * quietly ignored and showing everyone under a filter that says otherwise.
 */
async function keysFor(tx: Prisma.TransactionClient, shopId: string, pick: string): Promise<string[]> {
  if (pick.startsWith("group:")) {
    const groupId = pick.slice("group:".length);
    if (!groupId) return [];
    const members = await tx.service.findMany({
      where: { shopId, serviceGroupId: groupId },
      select: { id: true },
    });
    return members.map((m) => `id:${m.id}`);
  }
  if ((pick.startsWith("id:") && pick.length > 3) || (pick.startsWith("name:") && pick.length > 5)) {
    return [pick];
  }
  return [];
}

/** The ids of this shop's clients who had the picked service in the window. */
export async function clientsWhoHadService(
  tx: Prisma.TransactionClient,
  shopId: string,
  pick: string,
  within: ClientServiceWindow,
  now: Date,
): Promise<string[]> {
  const keys = await keysFor(tx, shopId, pick);
  if (keys.length === 0) return [];
  return [...(await serviceAudienceMembers(tx, shopId, keys, within, now))];
}

/**
 * What the filter lists: the shop's service groups first (only groups with a
 * service in them), then each service, then names only the old system used.
 * Any time, so a service nobody has had for a year can still be picked and
 * answer "nobody".
 */
export async function clientServiceOptions(
  tx: Prisma.TransactionClient,
  shopId: string,
  now: Date,
): Promise<ClientServiceOption[]> {
  const [groups, services] = await Promise.all([
    tx.serviceGroup.findMany({
      where: { shopId, services: { some: {} } },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    serviceAudienceOptions(tx, shopId, null, now),
  ]);
  return [
    ...groups.map((g) => ({ key: `group:${g.id}`, label: g.name, kind: "group" as const })),
    ...services.map((s) => ({ key: s.key, label: s.label, kind: s.source })),
  ];
}
