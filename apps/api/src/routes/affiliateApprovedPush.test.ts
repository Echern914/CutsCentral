import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";

const sendPushToUser = vi.fn(async (_p: unknown) => ({ sent: 1, pruned: 0, failed: 0, anyDelivered: true }));
vi.mock("../messaging/push.js", async (orig) => ({
  ...(await orig<typeof import("../messaging/push.js")>()),
  sendPushToUser: (p: unknown) => sendPushToUser(p),
}));

const { pushAffiliateApproved } = await import("./adminPortal.affiliate.js");

/**
 * Approved as an affiliate: the email was always queued with the approval;
 * the OWNER now also gets a push - to their phone, with a tap to the
 * affiliate page - and a failure there can never surface as an error.
 */
const users: string[] = [];

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});
beforeEach(() => sendPushToUser.mockClear());

describe("pushAffiliateApproved", () => {
  it("pushes the shop OWNER, with a tap to the affiliate page", async () => {
    const owner = await prisma.user.create({ data: { email: `aff-push-${randomToken(6)}@test.local`, passwordHash: "x", name: "Owner" } });
    users.push(owner.id);
    const shop = await prisma.shop.create({ data: { ownerId: owner.id, name: "Push Cuts", webhookSecret: randomToken() } });
    await pushAffiliateApproved(shop.id);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const arg = sendPushToUser.mock.calls[0]![0] as unknown as { userId: string; shopId: string; payload: { title: string; url: string; tag: string } };
    expect(arg.userId).toBe(owner.id);
    expect(arg.shopId).toBe(shop.id);
    expect(arg.payload.title).toBe("You're approved for the affiliate program");
    expect(arg.payload.url).toMatch(/\/dashboard\/affiliates$/);
    expect(arg.payload.tag).toBe("affiliate-approved");
  });

  it("never throws - an unknown shop or a failing push is logged and swallowed", async () => {
    await expect(pushAffiliateApproved("no-such-shop")).resolves.toBeUndefined();
    expect(sendPushToUser).not.toHaveBeenCalled();
    sendPushToUser.mockRejectedValueOnce(new Error("push down"));
    const owner = await prisma.user.create({ data: { email: `aff-push-${randomToken(6)}@test.local`, passwordHash: "x", name: "Owner" } });
    users.push(owner.id);
    const shop = await prisma.shop.create({ data: { ownerId: owner.id, name: "Push Cuts 2", webhookSecret: randomToken() } });
    await expect(pushAffiliateApproved(shop.id)).resolves.toBeUndefined();
  });
});
