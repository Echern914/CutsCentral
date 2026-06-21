import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { MessageProvider } from "../messaging/provider.js";
import { notifyPunchEarned, notifyRewardRedeemed } from "./loyaltyNotify.js";

/**
 * Transactional loyalty SMS gating: shop toggle, client consent, quiet hours,
 * and the rule that these sends are logged as kind="loyalty" (so they're NOT
 * counted against the marketing daily cap). Real send via a FAKE provider.
 */

// A weekday MIDDAY in America/New_York (the shop's default tz) - inside the
// 8am-9pm quiet-hours window, so a send is allowed.
const NOON = new Date("2026-06-01T16:00:00Z"); // 12:00 EDT
// 2am EDT - outside the window, so a send must be skipped.
const NIGHT = new Date("2026-06-01T06:00:00Z"); // 02:00 EDT

let sent: { to: string; body: string }[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    sent.push(input);
    return { sid: `SM${sent.length}`, status: "queued" };
  },
};

let userId: string;

/** A shop with the loyalty toggle on (unless overridden). */
async function makeShop(loyaltyTextsEnabled = true): Promise<Shop> {
  return prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Loyalty Shop",
      bookingUrl: "https://loyal.test",
      webhookSecret: randomToken(),
      loyaltyTextsEnabled,
    },
  });
}

/** A textable client: phone + recorded consent, not opted out. */
async function makeClient(
  shopId: string,
  overrides: { optedOut?: boolean; consented?: boolean } = {},
) {
  const consented = overrides.consented ?? true;
  const key = `tel:${randomToken(8)}`;
  // The scoped accessor exposes upsert (not create); a fresh key makes it an
  // insert. Matches the pattern in rewards.test.ts / nudge.test.ts.
  return forShop(shopId).client.upsert({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
    create: {
      acuityClientKey: key,
      magicToken: randomToken(),
      firstName: "Loyal",
      phone: "+13025550000",
      optedOut: overrides.optedOut ?? false,
      smsConsentAt: consented ? NOON : null,
      smsConsentSource: consented ? "barber_attest" : null,
    },
    update: {},
  });
}

beforeAll(async () => {
  __setMessageProviderForTests(fakeProvider);
  const user = await prisma.user.create({
    data: { email: `loyal-${randomToken(6)}@test.local`, passwordHash: "x", name: "L" },
  });
  userId = user.id;
});

afterEach(async () => {
  sent = [];
  await prisma.nudge.deleteMany({ where: { shop: { ownerId: userId } } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("notifyPunchEarned", () => {
  it("sends and logs a kind=loyalty SENT nudge when everything is in order", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await notifyPunchEarned({
      shopId: shop.id,
      clientId: client.id,
      earned: 2,
      balance: 4,
      now: NOON,
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toContain("2 punches");
    expect(sent[0]!.body).toContain("Loyalty Shop");
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.status).toBe("SENT");
    expect(nudge?.kind).toBe("loyalty");
    expect(nudge?.messageSid).toMatch(/^SM/);
  });

  it("skips silently when the shop toggle is off", async () => {
    const shop = await makeShop(false);
    const client = await makeClient(shop.id);
    await notifyPunchEarned({ shopId: shop.id, clientId: client.id, earned: 1, balance: 1, now: NOON });
    expect(sent.length).toBe(0);
    expect(await prisma.nudge.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("skips a client with no recorded consent", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id, { consented: false });
    await notifyPunchEarned({ shopId: shop.id, clientId: client.id, earned: 1, balance: 1, now: NOON });
    expect(sent.length).toBe(0);
  });

  it("skips an opted-out client", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id, { optedOut: true });
    await notifyPunchEarned({ shopId: shop.id, clientId: client.id, earned: 1, balance: 1, now: NOON });
    expect(sent.length).toBe(0);
  });

  it("skips outside quiet hours", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await notifyPunchEarned({ shopId: shop.id, clientId: client.id, earned: 1, balance: 1, now: NIGHT });
    expect(sent.length).toBe(0);
  });
});

describe("notifyRewardRedeemed", () => {
  it("sends a redemption confirmation naming the reward", async () => {
    const shop = await makeShop();
    const client = await makeClient(shop.id);
    await notifyRewardRedeemed({
      shopId: shop.id,
      clientId: client.id,
      rewardName: "Free Cut",
      balance: 0,
      now: NOON,
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toContain("Free Cut");
    const nudge = await prisma.nudge.findFirst({ where: { shopId: shop.id } });
    expect(nudge?.kind).toBe("loyalty");
  });
});
