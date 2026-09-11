import { Prisma, runAsOwner } from "@chairback/db";
import { DEMO } from "@chairback/config";
import { logger } from "../logger.js";
import type { SignInChannel } from "./customerSignIn.js";

/**
 * THE CANONICAL CUSTOMER IDENTITY - one person, however many shops.
 *
 * A CustomerAccount exists only because its owner proved a phone or an email
 * (services/customerSignIn.ts). It is linked to the shop records - Client rows,
 * one per shop - that carry that SAME proven contact, normalized. Never a
 * name, never a guess: `anon:` name-keyed rows have no contact and can't
 * match, and nothing is ever inferred without the proof.
 *
 * 🔴 THE LINKS ARE RE-DERIVED ON EVERY READ (syncCustomerLinks). The table is a
 * memory, not an authority:
 *   - a record whose phone/email no longer matches the proof, or that was
 *     archived or erased, is DETACHED the moment it is next read - so a barber
 *     correcting a mistyped number revokes access on the spot;
 *   - a record the customer disowned ("This isn't me") stays REJECTED for that
 *     account and is never linked again;
 *   - a record is ACTIVELY linked to at most one account (a partial unique
 *     index), so a household sharing a number with different emails can't
 *     have the same record surface in two accounts.
 *
 * This is the one deliberate cross-shop read the customer side of the product
 * makes, and it is gated on the proof: only the account's own verified
 * contacts are ever matched, and no caller-supplied shop, client or filter is
 * accepted anywhere in it.
 */

/** The ceiling on records one account can link - a human has a handful of shops. */
const MAX_LINKED_RECORDS = 60;

export interface ActiveLink {
  id: string;
  clientId: string;
  shopId: string;
  matchedBy: "phone" | "email";
}

/**
 * Find the account a proven contact belongs to, or create it. The contact is
 * stamped verified in the same write. Returns the account and whether it was
 * just created (the app asks a new customer what to call them).
 */
export async function accountForProof(opts: {
  channel: SignInChannel;
  identifier: string;
  now: Date;
}): Promise<{ id: string; tokenVersion: number; created: boolean }> {
  const { channel, identifier, now } = opts;
  const where =
    channel === "sms" ? { phoneE164: identifier } : { emailNormalized: identifier };
  const create =
    channel === "sms"
      ? { phoneE164: identifier, phoneVerifiedAt: now }
      : { emailNormalized: identifier, emailVerifiedAt: now };

  return runAsOwner(async (tx) => {
    const found = await tx.customerAccount.findUnique({
      where,
      select: { id: true, tokenVersion: true, isDemo: true },
    });
    if (found && !found.isDemo) {
      await tx.customerAccount.update({ where: { id: found.id }, data: { lastSeenAt: now } });
      return { id: found.id, tokenVersion: found.tokenVersion, created: false };
    }
    try {
      const made = await tx.customerAccount.create({
        data: { ...create, lastSeenAt: now },
        select: { id: true, tokenVersion: true },
      });
      return { ...made, created: true };
    } catch (err) {
      // Two first sign-ins raced on the same contact: the other one made it.
      if ((err as { code?: string }).code === "P2002") {
        const again = await tx.customerAccount.findUniqueOrThrow({
          where,
          select: { id: true, tokenVersion: true },
        });
        return { ...again, created: false };
      }
      throw err;
    }
  });
}

/**
 * The demo account (App Review, "just looking"): linked ONLY to the seeded
 * demo shop's showcase client. Idempotent - the demo tenant resets nightly
 * and the link is simply recomputed.
 */
export async function demoAccount(): Promise<{ id: string; tokenVersion: number } | null> {
  return runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { magicToken: DEMO.MAGIC_TOKEN },
      select: { id: true, shopId: true },
    });
    if (!client) return null;
    const existing = await tx.customerAccount.findFirst({
      where: { isDemo: true },
      select: { id: true, tokenVersion: true },
      orderBy: { createdAt: "asc" },
    });
    const account =
      existing ??
      (await tx.customerAccount.create({
        data: { isDemo: true, firstName: "Alex" },
        select: { id: true, tokenVersion: true },
      }));
    await tx.customerClientLink.deleteMany({
      where: { accountId: account.id, clientId: { not: client.id } },
    });
    await tx.customerClientLink.createMany({
      data: [{ accountId: account.id, clientId: client.id, shopId: client.shopId, matchedBy: "phone" }],
      skipDuplicates: true,
    });
    return account;
  });
}

interface CandidateRow {
  id: string;
  shopId: string;
  phone: string | null;
}

/**
 * Reconcile the account's links with its proof, and return the ACTIVE ones.
 * Cheap when nothing changed: one indexed match query and one link read.
 */
export async function syncCustomerLinks(accountId: string, now = new Date()): Promise<ActiveLink[]> {
  return runAsOwner(async (tx) => {
    const account = await tx.customerAccount.findUnique({
      where: { id: accountId },
      select: { phoneE164: true, emailNormalized: true, isDemo: true },
    });
    if (!account) return [];

    // The demo account's single link is set by demoAccount(); it has no proof
    // to reconcile against and must never reach a real shop.
    if (account.isDemo) {
      return (await tx.customerClientLink.findMany({
        where: { accountId, status: "active" },
        select: { id: true, clientId: true, shopId: true, matchedBy: true },
      })) as ActiveLink[];
    }

    const matchers: Prisma.Sql[] = [];
    if (account.phoneE164) matchers.push(Prisma.sql`c."phone" = ${account.phoneE164}`);
    if (account.emailNormalized) {
      // Equality on lower(email) (indexed) - never ILIKE, whose _ and % would
      // act as wildcards inside an address.
      matchers.push(Prisma.sql`lower(c."email") = ${account.emailNormalized}`);
    }
    const candidates: CandidateRow[] =
      matchers.length === 0
        ? []
        : await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
            SELECT c."id", c."shopId", c."phone"
            FROM "Client" c
            JOIN "Shop" s ON s."id" = c."shopId"
            WHERE c."archivedAt" IS NULL
              AND c."acuityClientKey" NOT LIKE 'deleted:%'
              AND s."slug" IS DISTINCT FROM ${DEMO.SHOP_SLUG}
              AND (${Prisma.join(matchers, " OR ")})
            ORDER BY c."id"
            LIMIT ${MAX_LINKED_RECORDS}`);

    const existing = await tx.customerClientLink.findMany({
      where: { accountId },
      select: { id: true, clientId: true, status: true },
    });
    const byClient = new Map(existing.map((l) => [l.clientId, l]));
    const candidateIds = new Set(candidates.map((c) => c.id));

    // New matches: link them. skipDuplicates makes a raced sync harmless AND
    // quietly declines a record another account already holds actively (the
    // partial unique index is a conflict like any other).
    const fresh = candidates.filter((c) => !byClient.has(c.id));
    if (fresh.length > 0) {
      await tx.customerClientLink.createMany({
        data: fresh.map((c) => ({
          accountId,
          clientId: c.id,
          shopId: c.shopId,
          // A phone match is the stronger claim; name it when both matched.
          matchedBy: account.phoneE164 !== null && c.phone === account.phoneE164 ? "phone" : "email",
        })),
        skipDuplicates: true,
      });
    }

    // Matching again after a detachment: re-activate - unless another account
    // took the record in the meantime (the partial unique refuses; leave it).
    // One statement per link: the NOT EXISTS makes "someone else holds it" a
    // no-op instead of a unique-violation that would abort the transaction.
    for (const link of existing) {
      if (link.status === "detached" && candidateIds.has(link.clientId)) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "CustomerClientLink" SET "status" = 'active', "statusAt" = ${now}
          WHERE "id" = ${link.id} AND "status" = 'detached'
            AND NOT EXISTS (
              SELECT 1 FROM "CustomerClientLink" o
              WHERE o."clientId" = ${link.clientId} AND o."status" = 'active'
            )`);
      }
    }

    // No longer matching (phone edited, archived, erased): detach now.
    const stale = existing
      .filter((l) => l.status === "active" && !candidateIds.has(l.clientId))
      .map((l) => l.id);
    if (stale.length > 0) {
      await tx.customerClientLink.updateMany({
        where: { id: { in: stale }, status: "active" },
        data: { status: "detached", statusAt: now },
      });
      // Counts only - never which records, never a contact.
      logger.info({ accountId, detached: stale.length }, "customer links: detached stale records");
    }

    return (await tx.customerClientLink.findMany({
      where: { accountId, status: "active" },
      select: { id: true, clientId: true, shopId: true, matchedBy: true },
      orderBy: { linkedAt: "asc" },
    })) as ActiveLink[];
  });
}

/**
 * "This isn't me": reject every record this account holds at one shop, and
 * remember it. The key is one of the account's own ACTIVE link ids; anything
 * else - another account's link, a rejected one, a made-up id - is null,
 * which the route answers as 404.
 */
export async function rejectShopForAccount(
  accountId: string,
  linkId: string,
  now = new Date(),
): Promise<{ shopId: string } | null> {
  return runAsOwner(async (tx) => {
    const link = await tx.customerClientLink.findFirst({
      where: { id: linkId, accountId, status: "active" },
      select: { shopId: true },
    });
    if (!link) return null;
    await tx.customerClientLink.updateMany({
      where: { accountId, shopId: link.shopId, status: { in: ["active", "detached"] } },
      data: { status: "rejected", statusAt: now },
    });
    logger.info({ accountId, shopId: link.shopId }, "customer links: shop rejected by customer");
    return { shopId: link.shopId };
  });
}
