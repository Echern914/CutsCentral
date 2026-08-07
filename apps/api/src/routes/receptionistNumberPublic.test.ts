import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The shop's AI text line on the CLIENT-facing payloads (/api/page/:slug and
 * /api/rewards/:magicToken).
 *
 * The whole point of the number is that clients text it, so the one thing that
 * must never happen is advertising a number that answers nobody: a shop whose
 * receptionist is off, un-entitled, or not on native booking would take the
 * text into silence. The payload is therefore gated on the SAME condition the
 * inbound handler uses to decide whether to reply, plus the shop owning its own
 * line (the shared platform line routes by the SENDER's phone, so a brand-new
 * visitor to the public page could not be routed at all).
 */
const app = createApp();
const email = `recnum-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let shopId: string;
let slug: string;
let magicToken: string;

const NUMBER = "+15550001111";

/** Put the shop in the fully-reachable state, then apply one override. */
async function setShop(patch: Record<string, unknown>) {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      twilioNumber: NUMBER,
      receptionistEnabled: true,
      receptionistCompAccess: true,
      receptionistTermsAcceptedAt: new Date(),
      bookingMode: "native",
      compAccess: true,
      publicPageEnabled: true,
      ...patch,
    },
  });
}

const publicNumber = async () =>
  (await request(app).get(`/api/page/${slug}`)).body.receptionistNumber;
const rewardsNumber = async () =>
  (await request(app).get(`/api/rewards/${magicToken}`)).body.shop.receptionistNumber;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Rec", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Text Me Cuts", smsAttested: true });
  shopId = shop.body.id;
  slug = shop.body.slug;

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `rec-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Reg",
    },
    select: { magicToken: true },
  });
  magicToken = client.magicToken;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("client-facing receptionist number", () => {
  it("is published on both payloads when the receptionist would answer", async () => {
    await setShop({});
    expect(await publicNumber()).toBe(NUMBER);
    expect(await rewardsNumber()).toBe(NUMBER);
  });

  it("is withheld when the receptionist is switched off", async () => {
    await setShop({ receptionistEnabled: false });
    expect(await publicNumber()).toBeNull();
    expect(await rewardsNumber()).toBeNull();
  });

  // The ENTITLEMENT gate (no Premium AI, no add-on, no comp) can't be exercised
  // here: hasReceptionistEntitlement short-circuits to true whenever platform
  // billing is off, which it always is in the test env, so dropping
  // receptionistCompAccess changes nothing. It is covered as a unit in
  // receptionist/config's own tests; what matters for THIS payload is that it
  // reads the same composite gate, which the cases around this one prove.

  it("is withheld when booking isn't native (the AI can't take appointments)", async () => {
    await setShop({ bookingMode: "acuity" });
    expect(await publicNumber()).toBeNull();
    expect(await rewardsNumber()).toBeNull();
  });

  it("is withheld when the terms were never accepted", async () => {
    await setShop({ receptionistTermsAcceptedAt: null });
    expect(await publicNumber()).toBeNull();
    expect(await rewardsNumber()).toBeNull();
  });

  it("is withheld on the SHARED line - a new texter could not be routed", async () => {
    await setShop({ twilioNumber: null });
    expect(await publicNumber()).toBeNull();
    expect(await rewardsNumber()).toBeNull();
  });
});
