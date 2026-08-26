import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { resolveWaitlistClient } from "../engines/waitlistClientLink.js";
import { RANK_GOLD, RANK_NONE, RANK_SILVER } from "../engines/waitlistTierRank.js";
import { toE164 } from "../acuity/clientKey.js";

/**
 * WaitlistEntry.clientId: the rule, and the two places that write it.
 *
 * The link decides which Client a waitlist entry is about. Nothing ranks by
 * it yet - reachability prefers it and falls back to the phone lookup it has
 * always used - but it is about to carry loyalty tier into the offer queue,
 * and a wrong link there hands one person another person's standing. So the
 * rule is narrow on purpose (engines/waitlistClientLink.ts), and these pin
 * every way it must REFUSE to guess:
 *
 *   two live clients on one number, an archived-only match, another shop's
 *   client, no number at all.
 *
 * Refusing is free: an entry with no link behaves exactly as it does today.
 */
const app = createApp();
const password = "supersecret123";

let cookie: string;
let shopId: string;
let slug: string;
let otherShopId: string;
const emails: string[] = [];

async function signupAndShop(name: string) {
  const email = `wl-link-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Link Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name, bookingUrl: "https://wl.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ waitlistEnabled: true, publicPageEnabled: true });
  return { cookie: c, shopId: shop.body.id as string, slug: shop.body.slug as string };
}

/** A client in `shop` holding exactly this (already normalized) number. */
async function makeClient(
  shop: string,
  phone: string | null,
  over: { archivedAt?: Date; loyaltyTier?: "BRONZE" | "SILVER" | "GOLD" } = {},
) {
  return prisma.client.create({
    data: {
      shopId: shop,
      firstName: "Cli",
      phone,
      acuityClientKey: `link-${randomToken(8)}`,
      magicToken: randomToken(),
      ...over,
    },
    select: { id: true },
  });
}

/**
 * The number as the ROUTES will store it. Both join paths run toE164 first,
 * so the fixture has to agree with them rather than guess - the rule compares
 * raw strings on purpose, and a fixture that disagreed would test nothing.
 */
let phoneSeq = 0;
function freshPhone(): { raw: string; stored: string } {
  phoneSeq += 1;
  const raw = `201555${String(2000 + phoneSeq).padStart(4, "0")}`;
  return { raw, stored: toE164(raw) ?? raw };
}

/** The link half of the rule, which is all the cases below care about. */
const linkOf = async (phone: string | null | undefined): Promise<string | null> =>
  (await resolveWaitlistClient(prisma, shopId, phone)).clientId;

beforeAll(async () => {
  const a = await signupAndShop("Link Cuts");
  cookie = a.cookie;
  shopId = a.shopId;
  slug = a.slug;
  const b = await signupAndShop("Other Cuts");
  otherShopId = b.shopId;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* The rule                                                            */
/* ------------------------------------------------------------------ */

describe("resolveWaitlistClient: the link", () => {
  it("links one unambiguous, non-archived client in the same shop", async () => {
    const { stored } = freshPhone();
    const c = await makeClient(shopId, stored);
    await expect(linkOf(stored)).resolves.toBe(c.id);
  });

  it("🔴 refuses when TWO live clients hold the number - a household is not a person", async () => {
    const { stored } = freshPhone();
    await makeClient(shopId, stored);
    await makeClient(shopId, stored);
    await expect(linkOf(stored)).resolves.toBeNull();
  });

  it("ignores archived clients, and links again once only one live match remains", async () => {
    const { stored } = freshPhone();
    const gone = await makeClient(shopId, stored, { archivedAt: new Date() });
    // Archived-only: nothing to link to.
    await expect(linkOf(stored)).resolves.toBeNull();
    // The re-added record is the one live match, and the archived duplicate
    // does not make it ambiguous.
    const live = await makeClient(shopId, stored);
    await expect(linkOf(stored)).resolves.toBe(live.id);
    expect(live.id).not.toBe(gone.id);
  });

  it("🔴 never crosses shops, even on an identical number", async () => {
    const { stored } = freshPhone();
    await makeClient(otherShopId, stored);
    await expect(linkOf(stored)).resolves.toBeNull();
  });

  it("no number, no link - null, empty and undefined all resolve to null", async () => {
    await expect(linkOf(null)).resolves.toBeNull();
    await expect(linkOf("")).resolves.toBeNull();
    await expect(linkOf(undefined)).resolves.toBeNull();
  });

  it("does not match a client whose phone is null", async () => {
    const { stored } = freshPhone();
    await makeClient(shopId, null);
    await expect(linkOf(stored)).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The two writers                                                     */
/* ------------------------------------------------------------------ */

describe("joining stamps the link", () => {
  it("public join: a matching number links; an ambiguous one does not", async () => {
    const hit = freshPhone();
    const client = await makeClient(shopId, hit.stored);
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Linked", phone: hit.raw });
    expect(res.status).toBe(201);

    const linked = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "Linked" },
      select: { clientId: true, phone: true },
    });
    expect(linked?.phone).toBe(hit.stored); // the fixture and the route agree
    expect(linked?.clientId).toBe(client.id);

    const dup = freshPhone();
    await makeClient(shopId, dup.stored);
    await makeClient(shopId, dup.stored);
    const res2 = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Ambiguous", phone: dup.raw });
    expect(res2.status).toBe(201);
    const amb = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "Ambiguous" },
      select: { clientId: true },
    });
    expect(amb?.clientId).toBeNull(); // waits, rather than guesses
  });

  it("public join with no phone at all still joins, unlinked", async () => {
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "NoPhone", email: `np-${randomToken(5)}@test.local` });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "NoPhone" },
      select: { clientId: true },
    });
    expect(e?.clientId).toBeNull();
  });

  it("dashboard join: the barber entering a known client's number links too", async () => {
    const hit = freshPhone();
    const client = await makeClient(shopId, hit.stored);
    const res = await request(app)
      .post("/api/dashboard/waitlist")
      .set("Cookie", cookie)
      .send({ firstName: "Counter", phone: hit.raw });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "Counter" },
      select: { clientId: true },
    });
    expect(e?.clientId).toBe(client.id);
  });

  it("🔴 a link is never to another shop's client, however the entry arrived", async () => {
    const hit = freshPhone();
    await makeClient(otherShopId, hit.stored);
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "CrossShop", phone: hit.raw });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "CrossShop" },
      select: { clientId: true },
    });
    expect(e?.clientId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The backfill is the same rule                                       */
/* ------------------------------------------------------------------ */

describe("🔴 the migration's backfill and the runtime rule are one rule", () => {
  it("running the SHIPPED statement reproduces resolveWaitlistClientId, every shape", async () => {
    // One rule, two implementations: SQL in the migration, TypeScript in the
    // engine. Different languages, different files, and a disagreement between
    // them is invisible - the backfill would mint links the fallback does not
    // agree with, which is the one outcome worse than no link at all.
    //
    // So this reads the shipped statement off disk and runs it. Editing the
    // migration edits what this test executes.
    const sql = readFileSync(
      new URL(
        "../../../../packages/db/prisma/migrations/" +
          "20260825140000_waitlist_entry_client_id/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const update = /UPDATE "WaitlistEntry" w[\s\S]*?;/.exec(sql)?.[0];
    expect(update).toBeTruthy();
    // Scoped to this shop and nothing else. The shipped statement is global
    // and the suite shares one database with every other test file; narrowing
    // which ROWS it touches does not change the RULE it applies.
    const scoped = update!.replace(/;\s*$/, ' AND w."shopId" = $1;');

    // Every shape the rule has to get right, seeded as if pre-migration.
    const one = freshPhone(); // exactly one live client
    const dup = freshPhone(); // two live clients on one number
    const arch = freshPhone(); // only an archived client
    const other = freshPhone(); // a live client, in another shop
    const orphan = freshPhone(); // nobody at all

    const liveOne = await makeClient(shopId, one.stored);
    await makeClient(shopId, dup.stored);
    await makeClient(shopId, dup.stored);
    await makeClient(shopId, arch.stored, { archivedAt: new Date() });
    await makeClient(otherShopId, other.stored);

    const ids: string[] = [];
    for (const c of [one, dup, arch, other, orphan]) {
      const e = await prisma.waitlistEntry.create({
        data: { shopId, firstName: "Backfill", phone: c.stored, clientId: null },
        select: { id: true },
      });
      ids.push(e.id);
    }
    const noPhone = await prisma.waitlistEntry.create({
      data: { shopId, firstName: "Backfill", phone: null, clientId: null },
      select: { id: true },
    });
    ids.push(noPhone.id);

    await prisma.$executeRawUnsafe(scoped, shopId);

    for (const id of ids) {
      const row = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id },
        select: { phone: true, clientId: true },
      });
      await expect(linkOf(row.phone)).resolves.toBe(
        row.clientId,
      );
    }

    // …and it linked the one it should have. A backfill that linked NOTHING
    // would agree with a rule that resolved nothing, and prove nothing.
    const linked = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "Backfill", phone: one.stored },
      select: { clientId: true },
    });
    expect(linked?.clientId).toBe(liveOne.id);
  });
});

/* ------------------------------------------------------------------ */
/* The rank                                                            */
/* ------------------------------------------------------------------ */

describe("resolveWaitlistClient: the rank", () => {
  const rankOf = async (phone: string | null | undefined): Promise<number> =>
    (await resolveWaitlistClient(prisma, shopId, phone)).tierRank;

  it("reads the linked client's tier", async () => {
    const g = freshPhone();
    await makeClient(shopId, g.stored, { loyaltyTier: "GOLD" });
    await expect(rankOf(g.stored)).resolves.toBe(RANK_GOLD);

    const s = freshPhone();
    await makeClient(shopId, s.stored, { loyaltyTier: "SILVER" });
    await expect(rankOf(s.stored)).resolves.toBe(RANK_SILVER);

    const b = freshPhone();
    await makeClient(shopId, b.stored, { loyaltyTier: "BRONZE" });
    await expect(rankOf(b.stored)).resolves.toBe(RANK_NONE);
  });

  it("🔴 no link means no tier, whatever the reason", async () => {
    // Every way the link can refuse ends at the same rank, because a rank
    // taken from a client we are not sure about is worse than no rank.
    const none = freshPhone();
    await expect(rankOf(none.stored)).resolves.toBe(RANK_NONE); // nobody
    await expect(rankOf(null)).resolves.toBe(RANK_NONE); // no number

    const dup = freshPhone();
    await makeClient(shopId, dup.stored, { loyaltyTier: "GOLD" });
    await makeClient(shopId, dup.stored, { loyaltyTier: "GOLD" });
    // Two live Gold clients on one number: still no link, so still no rank.
    // Guessing which record is "the" client would hand one person the
    // other's standing in the queue.
    await expect(rankOf(dup.stored)).resolves.toBe(RANK_NONE);

    const arch = freshPhone();
    await makeClient(shopId, arch.stored, { loyaltyTier: "GOLD", archivedAt: new Date() });
    await expect(rankOf(arch.stored)).resolves.toBe(RANK_NONE);

    const cross = freshPhone();
    await makeClient(otherShopId, cross.stored, { loyaltyTier: "GOLD" });
    await expect(rankOf(cross.stored)).resolves.toBe(RANK_NONE);
  });

  it("a linked client the loyalty engine has not tiered yet ranks with everyone else", async () => {
    const p = freshPhone();
    const c = await makeClient(shopId, p.stored); // loyaltyTier null
    const res = await resolveWaitlistClient(prisma, shopId, p.stored);
    expect(res.clientId).toBe(c.id); // linked …
    expect(res.tierRank).toBe(RANK_NONE); // … but no standing to rank by
  });
});

describe("joining stamps the rank", () => {
  it("🔴 the column DEFAULT is the no-standing rank", async () => {
    // The migration's DEFAULT and RANK_NONE are two copies of one number, in
    // two languages. This is the only thing that notices if they drift.
    const e = await prisma.waitlistEntry.create({
      data: { shopId, firstName: "Defaulted" },
      select: { tierRank: true },
    });
    expect(e.tierRank).toBe(RANK_NONE);
  });

  it("public join: a Gold client's entry is stamped Gold", async () => {
    const hit = freshPhone();
    await makeClient(shopId, hit.stored, { loyaltyTier: "GOLD" });
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "GoldJoin", phone: hit.raw });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "GoldJoin" },
      select: { tierRank: true },
    });
    expect(e?.tierRank).toBe(RANK_GOLD);
  });

  it("dashboard join: the barber entering a Silver client's number stamps Silver", async () => {
    const hit = freshPhone();
    await makeClient(shopId, hit.stored, { loyaltyTier: "SILVER" });
    const res = await request(app)
      .post("/api/dashboard/waitlist")
      .set("Cookie", cookie)
      .send({ firstName: "SilverCounter", phone: hit.raw });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "SilverCounter" },
      select: { tierRank: true },
    });
    expect(e?.tierRank).toBe(RANK_SILVER);
  });

  it("an unlinked join gets the no-standing rank, not a missing one", async () => {
    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Stranger", email: `st-${randomToken(5)}@test.local` });
    expect(res.status).toBe(201);
    const e = await prisma.waitlistEntry.findFirst({
      where: { shopId, firstName: "Stranger" },
      select: { tierRank: true, clientId: true },
    });
    expect(e?.clientId).toBeNull();
    expect(e?.tierRank).toBe(RANK_NONE);
  });

  it("🔴 THE RANK IS A SNAPSHOT: reaching Gold mid-wait does not restamp the entry", async () => {
    // ⚠️ THIS IS NOT A STALENESS BUG. Please do not "fix" it by recomputing
    // the rank on read or adding a sweep that refreshes it.
    //
    // They joined on Tuesday as a Bronze member. On Thursday their twelfth cut
    // lands and the loyalty engine stamps them Gold. They keep the Tuesday
    // place. Becoming Gold counts the NEXT time they join.
    //
    // A live join would mean the queue silently reorders itself between one
    // freed slot and the next - the person ahead of you on Tuesday is behind
    // you on Friday for reasons neither of you can see - and the same
    // cancellation replayed an hour later would pick a different person.
    const hit = freshPhone();
    const client = await makeClient(shopId, hit.stored, { loyaltyTier: "BRONZE" });

    const res = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "Promoted", phone: hit.raw });
    expect(res.status).toBe(201);
    const joined = await prisma.waitlistEntry.findFirstOrThrow({
      where: { shopId, firstName: "Promoted" },
      select: { id: true, tierRank: true, clientId: true },
    });
    expect(joined.clientId).toBe(client.id);
    expect(joined.tierRank).toBe(RANK_NONE); // Bronze ranks with everyone else

    // The loyalty engine promotes them while they are still waiting.
    await prisma.client.update({
      where: { id: client.id },
      data: { loyaltyTier: "GOLD" },
    });

    // The client is Gold now …
    await expect(
      resolveWaitlistClient(prisma, shopId, hit.stored),
    ).resolves.toMatchObject({ tierRank: RANK_GOLD });
    // … and the row they are waiting on has not moved.
    const after = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: joined.id },
      select: { tierRank: true },
    });
    expect(after.tierRank).toBe(RANK_NONE);

    // Their NEXT join is where being Gold counts. (They leave the queue first
    // - the join fingerprint's partial unique index covers the ACTIVE
    // statuses, so the same person cannot hold two live places at once.)
    await prisma.waitlistEntry.update({
      where: { id: joined.id },
      data: { status: "REMOVED" },
    });
    const again = await request(app)
      .post(`/api/page/${slug}/waitlist`)
      .send({ firstName: "PromotedAgain", phone: hit.raw });
    expect(again.status).toBe(201);
    const next = await prisma.waitlistEntry.findFirstOrThrow({
      where: { shopId, firstName: "PromotedAgain" },
      select: { tierRank: true },
    });
    expect(next.tierRank).toBe(RANK_GOLD);
  });
});
