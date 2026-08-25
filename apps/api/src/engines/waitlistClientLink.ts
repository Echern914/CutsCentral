import type { Prisma } from "@chairback/db";

/**
 * WaitlistEntry.clientId: the ONE rule that decides whether a waitlist entry
 * and a client record are the same person.
 *
 * A waitlist join is a public form. It captures a name, maybe a phone, maybe
 * an email — and no identity. Everything downstream that needs the actual
 * Client (today: "is there someone we can push to"; next: "what tier are
 * they") has re-derived that link by matching the phone string, in JS, once
 * per page of the candidate scan.
 *
 * The link column exists so a rank can be expressed in the ORDER BY. It is
 * only worth having if it means the SAME thing everywhere it is written, so
 * the rule lives here and the other two writers quote it:
 *
 *   - migrations/20260825140000_waitlist_entry_client_id (the backfill), and
 *   - engines/waitlistOffer.ts (the fallback for rows that never resolved).
 *
 * THE RULE: exactly one non-archived Client in the SAME shop whose phone
 * string is byte-identical to the entry's.
 *
 * 🔴 EXACTLY ONE. Two live clients can hold one number — a household, a shop
 * line, a duplicate nobody merged. The scan's phone map resolves that by
 * last-write-wins, i.e. by whatever order the rows came back in, which is
 * tolerable while the only question is "can we reach somebody". It stops
 * being tolerable the moment the answer decides whose loyalty tier applies
 * to whose place in the queue. Ambiguous stays NULL: an entry with no link
 * falls back to exactly the behaviour it has today, and a wrong link would
 * quietly hand one person another person's standing.
 *
 * 🔴 NO NORMALIZATION, on either side. The scan compares raw strings
 * (`phone: { in: [...] }`), so normalizing here would mint links the fallback
 * disagrees with — the one outcome worse than no link at all. Entries are
 * already stored E.164 when the number parsed (routes/shops.ts, dashboard.ts
 * both run toE164 first), so the two sides already agree in practice.
 *
 * 🔑 NOT identity, and never treated as such. This is a best-effort join for
 * ranking and reachability. It grants nothing: it is not consent, not
 * authentication, and not permission to show one person another's history.
 */
export async function resolveWaitlistClientId(
  tx: Prisma.TransactionClient,
  shopId: string,
  phone: string | null | undefined,
): Promise<string | null> {
  if (!phone) return null;
  const matches = await tx.client.findMany({
    where: { shopId, phone, archivedAt: null },
    select: { id: true },
    // One is a link. Two is an ambiguity, and a third would not make it any
    // more ambiguous — there is nothing to learn past the second row.
    take: 2,
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
