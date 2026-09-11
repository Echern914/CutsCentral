import { runWithShop } from "@chairback/db";

/**
 * The duplicates review: clients in ONE shop that share a phone number or an
 * email address, grouped so the barber can merge them (mergeClients in
 * client.ts) or say "not the same person" (a ClientDuplicateDismissal).
 *
 * Matching is on contact fields only - never on a name. Phone is stored E.164
 * already; email is compared trimmed and lowercased. Two different people CAN
 * share a contact (a parent booking for a child), which is why this only
 * SUGGESTS: nothing here merges anything, and a dismissed pair never comes back.
 *
 * Not candidates:
 *  - archived clients, which include the anonymized rows a customer deletion
 *    leaves (no phone or email survives one anyway);
 *  - a contact shared by more than MAX_SHARED_CONTACT active clients. That is a
 *    shop's own number typed in for walk-ins, or a "none@none.com" placeholder,
 *    not one person - offering to merge 30 walk-ins into one would be a trap.
 *
 * Everything runs inside runWithShop AND filters on shopId explicitly, so no
 * other shop's clients can ever appear in a group.
 */

export type DuplicateMatch = "phone" | "email";

export interface DuplicateCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  completedVisits: number;
  lastVisitAt: Date | null;
  createdAt: Date;
}

export interface DuplicateGroup {
  /** Stable for a given membership: the member ids, sorted and joined. */
  key: string;
  matchedOn: DuplicateMatch[];
  /** The suggested client to keep comes first: most completed visits, then the
   *  oldest record. The barber picks; this is only the default. */
  clients: DuplicateCandidate[];
}

/** A contact on more active clients than this is a shared placeholder. */
export const MAX_SHARED_CONTACT = 6;
/** Groups returned per request; `total` still counts them all. */
export const MAX_DUPLICATE_GROUPS = 50;

/** Byte-order compare, the same order the dismissal CHECK uses (COLLATE "C"). */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pairKey(a: string, b: string): string {
  return byteOrder(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`;
}

export async function findDuplicateGroups(
  shopId: string,
): Promise<{ groups: DuplicateGroup[]; total: number }> {
  return runWithShop(shopId, async (tx) => {
    // Every active client whose phone or email is shared with at least one
    // other active client (and at most MAX_SHARED_CONTACT of them).
    const rows = await tx.$queryRaw<
      { id: string; phone: string | null; emailKey: string | null }[]
    >`
      WITH active AS (
        SELECT id, phone, NULLIF(lower(btrim(email)), '') AS "emailKey"
        FROM "Client"
        WHERE "shopId" = ${shopId} AND "archivedAt" IS NULL
      ),
      shared_phone AS (
        SELECT phone FROM active WHERE phone IS NOT NULL
        GROUP BY phone HAVING count(*) BETWEEN 2 AND ${MAX_SHARED_CONTACT}
      ),
      shared_email AS (
        SELECT "emailKey" FROM active WHERE "emailKey" IS NOT NULL
        GROUP BY "emailKey" HAVING count(*) BETWEEN 2 AND ${MAX_SHARED_CONTACT}
      )
      SELECT id,
             CASE WHEN phone IN (SELECT phone FROM shared_phone) THEN phone END AS phone,
             CASE WHEN "emailKey" IN (SELECT "emailKey" FROM shared_email) THEN "emailKey" END AS "emailKey"
      FROM active
      WHERE phone IN (SELECT phone FROM shared_phone)
         OR "emailKey" IN (SELECT "emailKey" FROM shared_email)
    `;
    if (rows.length === 0) return { groups: [], total: 0 };

    const ids = rows.map((r) => r.id);
    const dismissed = new Set(
      (
        await tx.clientDuplicateDismissal.findMany({
          where: { shopId, OR: [{ clientAId: { in: ids } }, { clientBId: { in: ids } }] },
          select: { clientAId: true, clientBId: true },
        })
      ).map((d) => pairKey(d.clientAId, d.clientBId)),
    );

    // Contact -> the clients carrying it.
    const byContact = new Map<string, { match: DuplicateMatch; ids: string[] }>();
    for (const r of rows) {
      if (r.phone) {
        const k = `phone:${r.phone}`;
        const e = byContact.get(k) ?? { match: "phone" as const, ids: [] };
        e.ids.push(r.id);
        byContact.set(k, e);
      }
      if (r.emailKey) {
        const k = `email:${r.emailKey}`;
        const e = byContact.get(k) ?? { match: "email" as const, ids: [] };
        e.ids.push(r.id);
        byContact.set(k, e);
      }
    }

    // Union-find over every undismissed pair that shares a contact.
    const parent = new Map<string, string>(ids.map((id) => [id, id]));
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(x) !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const edgeMatches = new Map<string, Set<DuplicateMatch>>();
    for (const { match, ids: members } of byContact.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const pk = pairKey(members[i]!, members[j]!);
          if (dismissed.has(pk)) continue;
          const [ra, rb] = [find(members[i]!), find(members[j]!)];
          if (ra !== rb) parent.set(ra, rb);
          const m = edgeMatches.get(pk) ?? new Set<DuplicateMatch>();
          m.add(match);
          edgeMatches.set(pk, m);
        }
      }
    }

    const components = new Map<string, { ids: string[]; matched: Set<DuplicateMatch> }>();
    for (const [pk, matches] of edgeMatches) {
      const [a] = pk.split("|") as [string, string];
      const root = find(a);
      const c = components.get(root) ?? { ids: [], matched: new Set<DuplicateMatch>() };
      for (const m of matches) c.matched.add(m);
      components.set(root, c);
    }
    for (const id of ids) {
      const c = components.get(find(id));
      if (c && !c.ids.includes(id)) c.ids.push(id);
    }
    const groupsRaw = [...components.values()].filter((c) => c.ids.length >= 2);
    if (groupsRaw.length === 0) return { groups: [], total: 0 };

    // Sequential on purpose: one transaction is one connection.
    const memberIds = groupsRaw.flatMap((g) => g.ids);
    const clients = await tx.client.findMany({
      where: { shopId, id: { in: memberIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        lastVisitAt: true,
        createdAt: true,
      },
    });
    const visitCounts = await tx.visit.groupBy({
      by: ["clientId"],
      where: { shopId, clientId: { in: memberIds }, status: "COMPLETED" },
      _count: { _all: true },
    });
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const visitsById = new Map(visitCounts.map((v) => [v.clientId, v._count._all]));

    const groups: DuplicateGroup[] = groupsRaw.map((g) => {
      const members: DuplicateCandidate[] = g.ids
        .map((id) => clientById.get(id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .map((c) => ({ ...c, completedVisits: visitsById.get(c.id) ?? 0 }))
        .sort(
          (a, b) =>
            b.completedVisits - a.completedVisits ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            byteOrder(a.id, b.id),
        );
      return {
        key: [...g.ids].sort(byteOrder).join(","),
        matchedOn: (["phone", "email"] as const).filter((m) => g.matched.has(m)),
        clients: members,
      };
    });

    // Most recently seen first: the pairs a barber is likeliest to recognise.
    const lastSeen = (g: DuplicateGroup) =>
      Math.max(...g.clients.map((c) => (c.lastVisitAt ?? c.createdAt).getTime()));
    groups.sort((a, b) => lastSeen(b) - lastSeen(a) || byteOrder(a.key, b.key));
    return { groups: groups.slice(0, MAX_DUPLICATE_GROUPS), total: groups.length };
  });
}

export type DismissResult =
  | { ok: true; pairs: number }
  | { ok: false; reason: "not_found" };

/**
 * "Not the same person": record every pair among `clientIds` so the review never
 * groups them again. Every id must be a client of THIS shop, or nothing is
 * written. Idempotent (a pair already dismissed is skipped).
 */
export async function dismissDuplicates(
  shopId: string,
  clientIds: string[],
  actorUserId: string | null,
): Promise<DismissResult> {
  const ids = [...new Set(clientIds)].sort(byteOrder);
  return runWithShop(shopId, async (tx) => {
    const found = await tx.client.count({ where: { shopId, id: { in: ids } } });
    if (ids.length < 2 || found !== ids.length) return { ok: false, reason: "not_found" };
    const data: { shopId: string; clientAId: string; clientBId: string; actorUserId: string | null }[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        data.push({ shopId, clientAId: ids[i]!, clientBId: ids[j]!, actorUserId });
      }
    }
    const written = await tx.clientDuplicateDismissal.createMany({ data, skipDuplicates: true });
    return { ok: true, pairs: written.count };
  });
}
