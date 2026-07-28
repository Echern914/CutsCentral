import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";

/**
 * Shop-wide cap alerts. The property that matters is DEDUPE: the alert itself
 * costs an SMS, so firing one per capped inbound would hand an attacker a
 * second paid channel. Exactly one alert per shop/reason/window.
 */

const sendMock = vi.fn(async () => ({ sid: "SM_test" }));
vi.mock("../messaging/twilio.js", () => ({
  getMessageProvider: () => ({ send: sendMock }),
}));

const pushMock = vi.fn(async () => undefined);
vi.mock("../messaging/push.js", () => ({
  sendPushToUser: (...args: unknown[]) => pushMock(...(args as [])),
}));

const { alertShopCapTripped } = await import("./capAlert.js");

let userId: string;
let shopId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `capal-${randomToken(6)}@test.local`, passwordHash: "x", name: "C" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Cap Alert Shop",
      bookingUrl: "https://capal.test",
      webhookSecret: randomToken(),
      notifyPhone: "+13025550199",
    },
  });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.rateLimitCounter.deleteMany({
    where: { key: { contains: shopId } },
  });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  sendMock.mockClear();
  pushMock.mockClear();
});

describe("alertShopCapTripped", () => {
  // NOTE: the suite runs with DRY_RUN=true (repo-root .env), so the SMS leg is
  // deliberately log-only and the provider is never called. Push is NOT
  // DRY_RUN-gated, so it is the signal we assert the dedupe on. A dedicated
  // test below covers the DRY_RUN suppression itself.
  it("alerts the owner once, then dedupes repeat trips in the same window", async () => {
    await alertShopCapTripped({ shopId, reason: "shop_daily_cap" });
    expect(pushMock).toHaveBeenCalledTimes(1);

    // Five more capped inbounds in the same window must cost nothing.
    for (let i = 0; i < 5; i++) {
      await alertShopCapTripped({ shopId, reason: "shop_daily_cap" });
    }
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("tracks daily and monthly reasons independently", async () => {
    // The daily reason is already claimed by the test above; the monthly one
    // is a distinct key and must still get through exactly once.
    await alertShopCapTripped({ shopId, reason: "shop_monthly_cap" });
    expect(pushMock).toHaveBeenCalledTimes(1);

    await alertShopCapTripped({ shopId, reason: "shop_monthly_cap" });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the SMS leg under DRY_RUN (push still fires)", async () => {
    // Fresh shop so the dedupe key is unclaimed.
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Dry Run Shop",
        bookingUrl: "https://dry.test",
        webhookSecret: randomToken(),
        notifyPhone: "+13025550188",
      },
    });
    expect(process.env.DRY_RUN).toBe("true"); // guard the premise
    await alertShopCapTripped({ shopId: shop.id, reason: "shop_daily_cap" });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled(); // DRY_RUN = no paid send
  });

  it("does not throw when the shop is gone (alerting must never break the webhook)", async () => {
    await expect(
      alertShopCapTripped({ shopId: "missing-shop-id", reason: "shop_daily_cap" }),
    ).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
