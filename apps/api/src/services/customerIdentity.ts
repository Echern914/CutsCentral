import { createHmac } from "node:crypto";
import { Prisma, runAsOwner } from "@chairback/db";
import { DEMO, apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import type { SignInChannel } from "./customerSignIn.js";

/**
 * THE CANONICAL CUSTOMER IDENTITY - one person, however many shops.
 *
 * A CustomerAccount exists only because its owner proved a phone or an email
 * (services/customerSignIn.ts). This module decides which of the shops' own
 * Client rows that proof may open, and it is deliberately the narrowest part
 * of My ChairBack.
 *
 * 🔴 A VERIFIED CONTACT IS NOT PROOF THAT A RECORD IS YOURS.
 *
 * It proves you hold that phone or mailbox. It does not prove that every
 * record carrying it is about you - a parent books for a child on one number,
 * a couple shares an address, a barber types their own number for a walk-in,
 * and PR #418's duplicate review exists precisely because a shop can see two
 * records on one contact and know they are different people. So the rule is
 * fail-closed, and it is this:
 *
 *   AUTOMATIC, only when all four hold
 *     1. the record carries a contact this account has PROVEN;
 *     2. that contact names EXACTLY ONE eligible record at that shop;
 *     3. NO OTHER account has proven a contact this record carries - which is
 *        what stops "whoever signed in first keeps it" when one record holds
 *        one person's phone and another's email;
 *     4. the contact is not on more records than a person plausibly has
 *        (MAX_CONTACT_FANOUT), which is what a placeholder address looks like.
 *
 *   CLAIMED, otherwise: the customer also produces the shop's own link to that
 *     record (/r/<magicToken>). An HMAC of it is stored, so rotating the link
 *     revokes the claim. Ambiguity is NEVER resolved by offering a list of
 *     names to pick from: knowing a name is not proof of being that person.
 *
 *   AMBIGUOUS records expose NOTHING - no appointment, no visit, no reward, no
 *     manage link, no name. The portal says only that a shop has a profile it
 *     cannot safely connect, and how to connect it.
 *
 * Everything here is re-derived on every read, for every account that touches
 * the records in question - not just the caller's. A link is a memory, never
 * an authority.
 */

/**
 * How many eligible records one contact may appear on, platform-wide, before
 * it is treated as a shared or placeholder value rather than a person's own.
 * A real customer has a handful of shops; "none@none.com" has hundreds.
 */
export const MAX_CONTACT_FANOUT = 10;
/** Ceiling on records one account may hold by credential. */
export const MAX_CLAIMED_PROFILES = 25;

export type LinkBasis = "phone" | "email" | "claim";

export interface ActiveLink {
  id: string;
  clientId: string;
  shopId: string;
  matchedBy: LinkBasis;
}

/** What the account may see, and what it is being kept out of. */
export interface CustomerView {
  links: ActiveLink[];
  /**
   * Shops where a proven contact matched a record this account may NOT open.
   * Ids only - the caller turns them into the shop's own public details.
   */
  ambiguousShopIds: string[];
}

/** Purpose-tagged key, derived from the existing secret (no new env var). */
function claimKey(): string {
  return `${apiEnv().TOKEN_ENCRYPTION_KEY}:customer_profile_claim_v1`;
}

/** The stored proof that a customer held a record's own rewards link. */
export function claimDigest(magicToken: string): string {
  return createHmac("sha256", claimKey()).update(magicToken, "utf8").digest("hex");
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
 * and the link is simply recomputed. Demo links are never settled by the
 * engine below (the demo shop is excluded from every match it makes).
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
      data: [
        { accountId: account.id, clientId: client.id, shopId: client.shopId, matchedBy: "phone" },
      ],
      skipDuplicates: true,
    });
    return account;
  });
}

// ---------------------------------------------------------------------------
// The facts a decision is made from
// ---------------------------------------------------------------------------

interface ClientFact {
  id: string;
  shopId: string;
  phone: string | null;
  emailKey: string | null;
  magicToken: string;
  /** Archived, erased and demo-shop records are never linkable. */
  eligible: boolean;
  demoShop: boolean;
}

interface AccountFact {
  id: string;
  phone: string | null;
  email: string | null;
}

interface LinkRow {
  id: string;
  accountId: string;
  clientId: string;
  shopId: string;
  status: string;
  matchedBy: string;
  claimDigest: string | null;
}

/** A record that carries a given contact, with the shop it belongs to. */
interface ContactHit {
  contact: string;
  id: string;
  shopId: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Eligible = the shop's active book. Archived (which includes every record a
 * customer has had erased) and the seeded demo tenant are never matched.
 */
const ELIGIBLE = Prisma.sql`
  c."archivedAt" IS NULL
  AND c."acuityClientKey" NOT LIKE 'deleted:%'
  AND s."slug" IS DISTINCT FROM ${DEMO.SHOP_SLUG}`;

/** Inlined, never a bound parameter - a LIMIT that silently fails to bind is
 *  a batch size that does not exist (the lesson of PR #413's worker). */
const FANOUT_LIMIT = Prisma.raw(String(MAX_CONTACT_FANOUT + 1));

async function clientFacts(tx: Tx, ids: string[]): Promise<ClientFact[]> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<ClientFact[]>(Prisma.sql`
    SELECT c."id",
           c."shopId",
           c."phone",
           NULLIF(lower(btrim(c."email")), '') AS "emailKey",
           c."magicToken",
           (${ELIGIBLE}) AS "eligible",
           (s."slug" IS NOT DISTINCT FROM ${DEMO.SHOP_SLUG}) AS "demoShop"
    FROM "Client" c
    JOIN "Shop" s ON s."id" = c."shopId"
    WHERE c."id" = ANY(${ids}::text[])`);
}

/**
 * Every eligible record carrying each contact, capped one past the fan-out
 * ceiling so "this is a placeholder" is decidable without reading thousands
 * of rows.
 */
async function contactHits(
  tx: Tx,
  phones: string[],
  emails: string[],
): Promise<{ byPhone: Map<string, ContactHit[]>; byEmail: Map<string, ContactHit[]> }> {
  const byPhone = new Map<string, ContactHit[]>();
  const byEmail = new Map<string, ContactHit[]>();
  if (phones.length > 0) {
    const rows = await tx.$queryRaw<ContactHit[]>(Prisma.sql`
      SELECT k.v AS "contact", m."id", m."shopId"
      FROM unnest(${phones}::text[]) AS k(v)
      CROSS JOIN LATERAL (
        SELECT c."id", c."shopId"
        FROM "Client" c
        JOIN "Shop" s ON s."id" = c."shopId"
        WHERE c."phone" = k.v AND ${ELIGIBLE}
        ORDER BY c."id"
        LIMIT ${FANOUT_LIMIT}
      ) m`);
    for (const r of rows) byPhone.set(r.contact, [...(byPhone.get(r.contact) ?? []), r]);
  }
  if (emails.length > 0) {
    const rows = await tx.$queryRaw<ContactHit[]>(Prisma.sql`
      SELECT k.v AS "contact", m."id", m."shopId"
      FROM unnest(${emails}::text[]) AS k(v)
      CROSS JOIN LATERAL (
        SELECT c."id", c."shopId"
        FROM "Client" c
        JOIN "Shop" s ON s."id" = c."shopId"
        WHERE lower(btrim(c."email")) = k.v AND ${ELIGIBLE}
        ORDER BY c."id"
        LIMIT ${FANOUT_LIMIT}
      ) m`);
    for (const r of rows) byEmail.set(r.contact, [...(byEmail.get(r.contact) ?? []), r]);
  }
  return { byPhone, byEmail };
}

/**
 * Which OTHER people have proven a contact these records carry. Two accounts
 * on one record is the state nothing may resolve on its own.
 */
async function competingAccounts(
  tx: Tx,
  phones: string[],
  emails: string[],
): Promise<AccountFact[]> {
  if (phones.length === 0 && emails.length === 0) return [];
  const rows = await tx.customerAccount.findMany({
    where: {
      isDemo: false,
      OR: [
        ...(phones.length > 0 ? [{ phoneE164: { in: phones } }] : []),
        ...(emails.length > 0 ? [{ emailNormalized: { in: emails } }] : []),
      ],
    },
    select: { id: true, phoneE164: true, emailNormalized: true },
  });
  return rows.map((r) => ({ id: r.id, phone: r.phoneE164, email: r.emailNormalized }));
}

/**
 * Records a shop has explicitly said are DIFFERENT PEOPLE who share a contact
 * (PR #418's "Not the same person"). Such a record is never linked by that
 * contact again, whatever happens to the other one - including its being
 * archived, which would otherwise make the contact look unambiguous.
 *
 * 🔴 ASKS THE CATALOG FIRST, rather than querying and catching. The duplicate
 * review ships in a later PR, so on an API deployed before it the table does
 * not exist - and a failed statement poisons the whole transaction in
 * Postgres, so "try it and shrug" would take the customer's home down with it.
 */
async function dismissedClients(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [present] = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
    SELECT to_regclass('public."ClientDuplicateDismissal"') IS NOT NULL AS "ok"`);
  if (!present?.ok) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "clientAId" AS "id" FROM "ClientDuplicateDismissal"
     WHERE "clientAId" = ANY(${ids}::text[])
    UNION
    SELECT "clientBId" AS "id" FROM "ClientDuplicateDismissal"
     WHERE "clientBId" = ANY(${ids}::text[])`);
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

type DetachReason =
  | "ineligible"
  | "contact_changed"
  | "credential_rotated"
  | "contested"
  | "shared_contact"
  | "placeholder_contact"
  | "marked_different_people";

interface Plan {
  detach: { id: string; reason: DetachReason }[];
  activate: { linkId: string }[];
  create: { accountId: string; clientId: string; shopId: string; matchedBy: "phone" | "email" }[];
}

/** Which of an account's proven contacts this record carries. */
function sharedContacts(a: AccountFact, c: ClientFact): { value: string; kind: "phone" | "email" }[] {
  const out: { value: string; kind: "phone" | "email" }[] = [];
  if (a.phone && c.phone && a.phone === c.phone) out.push({ value: a.phone, kind: "phone" });
  if (a.email && c.emailKey && a.email === c.emailKey) out.push({ value: a.email, kind: "email" });
  return out;
}

/**
 * Settle every account's claim on these records, and write the result.
 *
 * Callers: the sign-in/read sync, a claim, a rejection, the push path, and
 * PR #418's merge - all of them so that "who may see this record" is decided
 * in ONE place, at write time, instead of each caller repairing it later.
 */
export async function settleClientLinks(
  tx: Tx,
  clientIds: string[],
  now = new Date(),
): Promise<void> {
  const ids = [...new Set(clientIds)].filter((id) => id.length > 0).sort();
  if (ids.length === 0) return;

  // Per-record serialization: two settles of one record (a sign-in and a
  // merge, say) must not each decide from a snapshot the other invalidates.
  // Sorted, so two transactions can never take them in opposite orders.
  for (const id of ids) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`ccl:${id}`}))`);
  }

  const facts = (await clientFacts(tx, ids)).filter((c) => !c.demoShop);
  if (facts.length === 0) return;

  const phones = [...new Set(facts.map((c) => c.phone).filter((p): p is string => p !== null))];
  const emails = [...new Set(facts.map((c) => c.emailKey).filter((e): e is string => e !== null))];
  const [{ byPhone, byEmail }, accounts, dismissed, links] = await Promise.all([
    contactHits(tx, phones, emails),
    competingAccounts(tx, phones, emails),
    dismissedClients(tx, facts.map((c) => c.id)),
    tx.customerClientLink.findMany({
      where: { clientId: { in: facts.map((c) => c.id) } },
      select: {
        id: true,
        accountId: true,
        clientId: true,
        shopId: true,
        status: true,
        matchedBy: true,
        claimDigest: true,
      },
    }) as Promise<LinkRow[]>,
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const plan: Plan = { detach: [], activate: [], create: [] };

  for (const c of facts) {
    const hitsFor = (k: { value: string; kind: "phone" | "email" }): ContactHit[] =>
      (k.kind === "phone" ? byPhone.get(k.value) : byEmail.get(k.value)) ?? [];
    const placeholder = (k: { value: string; kind: "phone" | "email" }): boolean =>
      hitsFor(k).length > MAX_CONTACT_FANOUT;
    const onlyRecordAtShop = (k: { value: string; kind: "phone" | "email" }): boolean =>
      hitsFor(k).filter((h) => h.shopId === c.shopId).length === 1;

    const onClient = links.filter((l) => l.clientId === c.id);
    // An account that DISOWNED this record is not competing for it: they said
    // it is not theirs, which is the one thing that resolves a shared contact
    // without a credential.
    const disowned = new Set(
      onClient.filter((l) => l.status === "rejected").map((l) => l.accountId),
    );
    const competitors = accounts.filter(
      (a) => !disowned.has(a.id) && sharedContacts(a, c).length > 0,
    );

    /** The contact that would link this account automatically, if any. */
    const autoContact = (a: AccountFact) =>
      sharedContacts(a, c).find((k) => !placeholder(k) && onlyRecordAtShop(k)) ?? null;

    let activeHolder: string | null = null;
    for (const link of onClient) {
      if (link.status !== "active") continue;
      const acct = accountById.get(link.accountId);
      const matched = acct ? sharedContacts(acct, c).length > 0 : false;
      let bad: DetachReason | null = null;
      if (!c.eligible) bad = "ineligible";
      else if (!acct || !matched) bad = "contact_changed";
      else if (link.matchedBy === "claim") {
        // The credential is what proved this one; a rotated link revokes it.
        if (link.claimDigest !== claimDigest(c.magicToken)) bad = "credential_rotated";
      } else if (dismissed.has(c.id)) bad = "marked_different_people";
      else if (competitors.length > 1 || competitors[0]?.id !== link.accountId) bad = "contested";
      else {
        const k = autoContact(acct);
        if (!k) {
          bad = sharedContacts(acct, c).some((x) => placeholder(x))
            ? "placeholder_contact"
            : "shared_contact";
        }
      }
      if (bad) plan.detach.push({ id: link.id, reason: bad });
      else activeHolder = link.accountId;
    }

    // Nobody holds it: may exactly one account take it automatically?
    if (activeHolder === null && c.eligible && !dismissed.has(c.id) && competitors.length === 1) {
      const only = competitors[0]!;
      const k = autoContact(only);
      const existing = onClient.find((l) => l.accountId === only.id);
      if (k && existing?.status !== "rejected") {
        if (existing) plan.activate.push({ linkId: existing.id });
        else
          plan.create.push({
            accountId: only.id,
            clientId: c.id,
            shopId: c.shopId,
            matchedBy: k.kind,
          });
      }
    }
  }

  await applyPlan(tx, plan, now);
}

async function applyPlan(tx: Tx, plan: Plan, now: Date): Promise<void> {
  for (const d of plan.detach) {
    await tx.customerClientLink.updateMany({
      where: { id: d.id, status: "active" },
      data: { status: "detached", statusReason: d.reason, statusAt: now },
    });
  }
  for (const a of plan.activate) {
    // NOT EXISTS rather than a plain update: another account may have taken
    // the record between the read and here, and the partial unique index
    // would abort the whole transaction instead of skipping this one row.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "CustomerClientLink" l
         SET "status" = 'active',
             "statusAt" = ${now.toISOString()}::timestamp,
             "statusReason" = NULL
       WHERE l."id" = ${a.linkId} AND l."status" = 'detached'
         AND NOT EXISTS (
           SELECT 1 FROM "CustomerClientLink" o
            WHERE o."clientId" = l."clientId" AND o."status" = 'active'
         )`);
  }
  if (plan.create.length > 0) {
    // skipDuplicates covers both the (account, client) unique and the partial
    // "one active link per record" index: a raced settle is a no-op, not a
    // 500. Rows are only ever created for accounts that were competitors.
    await tx.customerClientLink.createMany({
      data: plan.create.map((c) => ({ ...c, status: "active", statusAt: now })),
      skipDuplicates: true,
    });
  }
  if (plan.detach.length > 0) {
    // Counts and reasons only - never which account, record or contact.
    const reasons = plan.detach.reduce<Record<string, number>>((acc, d) => {
      acc[d.reason] = (acc[d.reason] ?? 0) + 1;
      return acc;
    }, {});
    logger.info({ reasons }, "customer links: detached");
  }
}

// ---------------------------------------------------------------------------
// What one account may see
// ---------------------------------------------------------------------------

/**
 * Reconcile this account's links with its proof and return the ACTIVE ones,
 * plus the shops where a contact matched something it may not open.
 */
export async function syncCustomerView(accountId: string, now = new Date()): Promise<CustomerView> {
  return runAsOwner(async (tx) => {
    const account = await tx.customerAccount.findUnique({
      where: { id: accountId },
      select: { phoneE164: true, emailNormalized: true, isDemo: true },
    });
    if (!account) return { links: [], ambiguousShopIds: [] };

    // The demo account's single link is set by demoAccount(); it has no proof
    // to reconcile against and must never reach a real shop.
    if (account.isDemo) {
      const links = (await tx.customerClientLink.findMany({
        where: { accountId, status: "active" },
        select: { id: true, clientId: true, shopId: true, matchedBy: true },
      })) as ActiveLink[];
      return { links, ambiguousShopIds: [] };
    }

    const phones = account.phoneE164 ? [account.phoneE164] : [];
    const emails = account.emailNormalized ? [account.emailNormalized] : [];
    const { byPhone, byEmail } = await contactHits(tx, phones, emails);
    const matches: ContactHit[] = [];
    for (const [, hits] of [...byPhone, ...byEmail]) {
      // A contact on more records than a person plausibly has is a placeholder
      // somebody else typed: it links nothing, and it is not even listed as a
      // shop to connect (that would hand out a map of where it appears).
      if (hits.length <= MAX_CONTACT_FANOUT) matches.push(...hits);
    }

    const held = await tx.customerClientLink.findMany({
      where: { accountId },
      select: { clientId: true, shopId: true, status: true },
    });
    await settleClientLinks(
      tx,
      [...matches.map((m) => m.id), ...held.map((h) => h.clientId)],
      now,
    );

    const links = (await tx.customerClientLink.findMany({
      where: { accountId, status: "active" },
      select: { id: true, clientId: true, shopId: true, matchedBy: true },
      orderBy: { linkedAt: "asc" },
    })) as ActiveLink[];

    // A shop is "ambiguous" when this account's contact matched a record
    // there that it holds none of - and has not disowned all of.
    const rejected = new Set(
      held.filter((h) => h.status === "rejected").map((h) => h.clientId),
    );
    const openShops = new Set(links.map((l) => l.shopId));
    const ambiguousShopIds = [
      ...new Set(
        matches
          .filter((m) => !openShops.has(m.shopId) && !rejected.has(m.id))
          .map((m) => m.shopId),
      ),
    ];
    return { links, ambiguousShopIds };
  });
}

/** The active links alone - the shape most callers want. */
export async function syncCustomerLinks(accountId: string, now = new Date()): Promise<ActiveLink[]> {
  return (await syncCustomerView(accountId, now)).links;
}

/**
 * The account a push for this record should also reach, re-derived NOW.
 *
 * A shop correcting a phone, a record being archived, or a second person
 * proving a contact on it all invalidate a link - and none of them happens on
 * the customer's own device, so waiting for their next read would let the
 * wrong phone buzz with somebody else's appointment in the meantime.
 */
export async function accountForClientPush(
  clientId: string,
  now = new Date(),
): Promise<{ accountId: string; pushEnabled: boolean } | null> {
  return runAsOwner(async (tx) => {
    await settleClientLinks(tx, [clientId], now);
    const link = await tx.customerClientLink.findFirst({
      where: { clientId, status: "active" },
      select: { account: { select: { id: true, pushEnabled: true, isDemo: true } } },
    });
    if (!link || link.account.isDemo) return null;
    return { accountId: link.account.id, pushEnabled: link.account.pushEnabled };
  });
}

/**
 * Settle the customer links when a shop MERGES two duplicate records, inside
 * the merge's own transaction.
 *
 * 🔴 NOT LEFT TO THE NEXT READ. The loser's history has just moved onto the
 * survivor; a link that still points at the archived record is an app showing
 * a customer an empty profile while their visits sit somewhere else, and a
 * link that survives on the WRONG account is worse than that. Both are decided
 * here, atomically with the move - if the merge rolls back, so does this.
 *
 * The cases, and why:
 *
 *   ONE account held either half (or both)   it carries onto the survivor. A
 *     claimed link carries as a claim, re-bound to the survivor's own
 *     credential: the shop has just asserted these are one person, which is
 *     the same authority the claim rested on.
 *
 *   TWO DIFFERENT accounts held the two halves   NEITHER keeps it. The shop
 *     says one person; two accounts say otherwise; the platform cannot tell
 *     which is right, and the combined record now contains both histories. It
 *     becomes ambiguous - connectable with the survivor's link, by whoever
 *     actually holds it.
 *
 *   An account that DISOWNED the loser   keeps disowning the survivor. It
 *     contains what they said was not theirs, so an active link they held on
 *     the survivor is dropped too.
 *
 * Everything then goes through the ordinary settle, so a carried link that
 * does not stand up (the survivor never carried that contact) is detached in
 * the same transaction rather than lingering.
 */
export async function settleLinksForMerge(
  tx: Tx,
  p: { shopId: string; winnerId: string; loserId: string; now?: Date },
): Promise<void> {
  const now = p.now ?? new Date();
  const [winner] = await clientFacts(tx, [p.winnerId]);
  if (!winner) return;

  const links = (await tx.customerClientLink.findMany({
    where: { clientId: { in: [p.winnerId, p.loserId] } },
    select: {
      id: true,
      accountId: true,
      clientId: true,
      shopId: true,
      status: true,
      matchedBy: true,
      claimDigest: true,
    },
  })) as LinkRow[];
  const onLoser = links.filter((l) => l.clientId === p.loserId);
  const onWinner = links.filter((l) => l.clientId === p.winnerId);
  const activeLoser = onLoser.find((l) => l.status === "active") ?? null;
  const activeWinner = onWinner.find((l) => l.status === "active") ?? null;

  const detach = (ids: string[], reason: string) =>
    ids.length === 0
      ? Promise.resolve({ count: 0 })
      : tx.customerClientLink.updateMany({
          where: { id: { in: ids }, status: "active" },
          data: { status: "detached", statusReason: reason, statusAt: now },
        });

  if (activeLoser && activeWinner && activeLoser.accountId !== activeWinner.accountId) {
    await detach([activeLoser.id, activeWinner.id], "merge_conflict");
  } else if (activeLoser) {
    const target = onWinner.find((l) => l.accountId === activeLoser.accountId);
    const carried =
      activeLoser.matchedBy === "claim"
        ? { matchedBy: "claim", claimDigest: claimDigest(winner.magicToken) }
        : { matchedBy: activeLoser.matchedBy, claimDigest: null };
    if (target?.status !== "rejected") {
      if (target) {
        await tx.customerClientLink.update({
          where: { id: target.id },
          data: { ...carried, status: "active", statusReason: null, statusAt: now },
        });
      } else {
        await tx.customerClientLink.create({
          data: {
            ...carried,
            accountId: activeLoser.accountId,
            clientId: p.winnerId,
            shopId: p.shopId,
            status: "active",
            statusAt: now,
          },
        });
      }
    }
    await detach([activeLoser.id], "merged");
  }

  // A half somebody disowned taints the whole.
  for (const rejected of onLoser.filter((l) => l.status === "rejected")) {
    const target = onWinner.find((l) => l.accountId === rejected.accountId);
    if (target) {
      await tx.customerClientLink.updateMany({
        where: { id: target.id },
        data: { status: "rejected", statusReason: "not_me_merged", statusAt: now },
      });
    } else {
      await tx.customerClientLink.create({
        data: {
          accountId: rejected.accountId,
          clientId: p.winnerId,
          shopId: p.shopId,
          // A disowned row is never matched ON; it only remembers the answer.
          // 'claim' would demand a credential digest it has no business
          // holding, so a carried rejection records the plainer basis.
          matchedBy: rejected.matchedBy === "claim" ? "phone" : rejected.matchedBy,
          status: "rejected",
          statusReason: "not_me_merged",
          statusAt: now,
        },
      });
    }
  }

  await settleClientLinks(tx, [p.winnerId, p.loserId], now);
}

export type ClaimOutcome =
  | { ok: true; shopId: string; clientId: string }
  | { ok: false; reason: "not_found" | "claimed_elsewhere" | "too_many" };

/**
 * Connect ONE record with the shop's own link to it (/r/<magicToken>).
 *
 * This is the only way an ambiguous record is ever opened, and it needs BOTH
 * halves: the account's verified contact on the record (so a forwarded link
 * cannot pull a stranger's history into an unrelated account) and the
 * credential itself (so a shared phone number cannot). "Not found" answers
 * every refusal that could otherwise confirm a record exists.
 */
export async function claimProfile(
  accountId: string,
  magicToken: string,
  now = new Date(),
): Promise<ClaimOutcome> {
  return runAsOwner(async (tx) => {
    const account = await tx.customerAccount.findUnique({
      where: { id: accountId },
      select: { phoneE164: true, emailNormalized: true, isDemo: true },
    });
    if (!account || account.isDemo) return { ok: false, reason: "not_found" };

    const client = await tx.client.findUnique({
      where: { magicToken },
      select: { id: true },
    });
    if (!client) return { ok: false, reason: "not_found" };

    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`ccl:${client.id}`}))`,
    );
    const [fact] = await clientFacts(tx, [client.id]);
    if (!fact || !fact.eligible) return { ok: false, reason: "not_found" };

    const me: AccountFact = {
      id: accountId,
      phone: account.phoneE164,
      email: account.emailNormalized,
    };
    if (sharedContacts(me, fact).length === 0) return { ok: false, reason: "not_found" };

    const taken = await tx.customerClientLink.findFirst({
      where: { clientId: fact.id, status: "active", accountId: { not: accountId } },
      select: { id: true },
    });
    if (taken) return { ok: false, reason: "claimed_elsewhere" };

    const mine = await tx.customerClientLink.count({
      where: { accountId, status: "active", matchedBy: "claim" },
    });
    if (mine >= MAX_CLAIMED_PROFILES) return { ok: false, reason: "too_many" };

    const digest = claimDigest(magicToken);
    const existing = await tx.customerClientLink.findFirst({
      where: { accountId, clientId: fact.id },
      select: { id: true },
    });
    if (existing) {
      await tx.customerClientLink.update({
        where: { id: existing.id },
        data: {
          status: "active",
          statusReason: null,
          statusAt: now,
          matchedBy: "claim",
          claimDigest: digest,
        },
      });
    } else {
      await tx.customerClientLink.create({
        data: {
          accountId,
          clientId: fact.id,
          shopId: fact.shopId,
          matchedBy: "claim",
          claimDigest: digest,
          status: "active",
          statusAt: now,
        },
      });
    }
    // Everyone else's claim on this record is re-decided in the same
    // transaction - a claim can only ever take a record nobody else holds.
    await settleClientLinks(tx, [fact.id], now);
    const still = await tx.customerClientLink.findFirst({
      where: { accountId, clientId: fact.id, status: "active" },
      select: { id: true },
    });
    if (!still) return { ok: false, reason: "claimed_elsewhere" };
    logger.info({ accountId, shopId: fact.shopId }, "customer links: profile claimed");
    return { ok: true, shopId: fact.shopId, clientId: fact.id };
  });
}

/**
 * "This isn't me", for ONE profile.
 *
 * Deliberately not "everything at this shop": where two people share a phone,
 * the whole point is that one of the records IS theirs. The key is one of the
 * account's own ACTIVE link ids; anything else is null, which the route
 * answers as 404. The rejection is remembered, so the record is never linked
 * automatically again - until the customer claims it with the shop's link.
 */
export async function rejectProfileForAccount(
  accountId: string,
  linkId: string,
  now = new Date(),
): Promise<{ shopId: string; clientId: string } | null> {
  return runAsOwner(async (tx) => {
    const link = await tx.customerClientLink.findFirst({
      where: { id: linkId, accountId, status: "active" },
      select: { shopId: true, clientId: true },
    });
    if (!link) return null;
    // matchedBy and any credential digest are left exactly as they were: how
    // it was matched is a fact about the past, and a CHECK ties the two
    // together. What changes is that it is now disowned.
    await tx.customerClientLink.updateMany({
      where: { id: linkId, accountId },
      data: { status: "rejected", statusReason: "not_me", statusAt: now },
    });
    // The record may now be unambiguously somebody else's - settle says so.
    await settleClientLinks(tx, [link.clientId], now);
    logger.info({ accountId, shopId: link.shopId }, "customer links: profile disowned");
    return link;
  });
}
