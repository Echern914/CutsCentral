import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { runEmailOutbox } from "../engines/emailOutbox.js";
import { approveApplication, rejectApplication } from "./affiliate.js";
import { affiliateEmailKey, enqueueAffiliateEmail } from "./affiliateNotify.js";

/**
 * The affiliate emails through the real outbox.
 *
 * Pinned: the intent is written in the same transaction as the decision;
 * a CAS replay leaves ONE intent; the worker sends to the affiliate's OWNER
 * and never names a referred business; a stale "ready" email for a reward
 * that was reversed in the meantime is superseded, not sent; a second pass
 * sends nothing; and with no provider configured an intent is suppressed,
 * not left to blast later.
 */

const emails: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];
const sent: SendEmailInput[] = [];

async function owner(label: string): Promise<{ userId: string; email: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: label }, select: { id: true } });
  return { userId: user.id, email };
}

async function shop(ownerId: string, name: string): Promise<string> {
  const s = await prisma.shop.create({
    data: {
      ownerId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomToken(4)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
    select: { id: true },
  });
  shopIds.push(s.id);
  return s.id;
}

async function pendingApplication(shopId: string, userId: string): Promise<string> {
  return runAsOwner(async (tx) => {
    const now = new Date();
    const app = await tx.affiliateApplication.create({
      data: {
        shopId,
        submittedByUserId: userId,
        status: "PENDING",
        audienceDescription: "clients",
        promotionPlan: "share",
        ftcAcknowledgedAt: now,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: now,
      },
      select: { id: true },
    });
    return app.id;
  });
}

function affiliateSends(): SendEmailInput[] {
  return sent.filter((s) => s.idempotencyKey?.startsWith("affiliate:"));
}

let admin: { userId: string; email: string };

beforeAll(async () => {
  __resetEnvCacheForTests();
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { status: "sent", id: `msg_${randomToken(8)}` };
  });
  admin = await owner("Operator");
  await prisma.user.update({ where: { id: admin.userId }, data: { isAdmin: true } });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await runAsOwner(async (tx) => {
    await tx.emailIntent.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.emailDelivery.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.affiliateReward.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateReferralAttribution.deleteMany({
      where: { affiliateAccountId: { in: accountIds } },
    });
  });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

describe("approval", () => {
  it("writes the intent with the approval, once, and the worker mails the owner their link", async () => {
    const o = await owner("Approved");
    const shopId = await shop(o.userId, "Approved Studio");
    const appId = await pendingApplication(shopId, o.userId);

    const first = await approveApplication({ applicationId: appId, adminUserId: admin.userId });
    expect(first.ok).toBe(true);
    if (first.ok) accountIds.push(first.value.account.id);
    const replay = await approveApplication({ applicationId: appId, adminUserId: admin.userId });
    expect(replay.ok).toBe(false);

    const key = affiliateEmailKey("affiliate_approved", appId);
    const intents = await runAsOwner((tx) => tx.emailIntent.findMany({ where: { idempotencyKey: key } }));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("PENDING");
    expect(intents[0]!.shopId).toBe(shopId);

    sent.length = 0;
    await runEmailOutbox({ batch: 100 });
    const mine = affiliateSends().filter((s) => s.idempotencyKey === key);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe(o.email);
    expect(mine[0]!.subject).toMatch(/affiliate link is ready/i);
    expect(mine[0]!.text).toContain("/join?ref=");
    expect(mine[0]!.text).toMatch(/say you're a ChairBack affiliate/i);
    expect(mine[0]!.text).not.toMatch(/\$\s?\d/);

    const after = await runAsOwner((tx) => tx.emailIntent.findUnique({ where: { idempotencyKey: key } }));
    expect(after?.status).toBe("SENT");
    expect(after?.messageId).toBeTruthy();
    const delivery = await runAsOwner((tx) =>
      tx.emailDelivery.findUnique({ where: { messageId: after!.messageId! } }),
    );
    expect(delivery?.kind).toBe("affiliate");

    // A second pass has nothing left to send for this key.
    sent.length = 0;
    await runEmailOutbox({ batch: 100 });
    expect(affiliateSends().filter((s) => s.idempotencyKey === key)).toHaveLength(0);
  });
});

describe("rejection", () => {
  it("mails the fixed public sentence, and invites a reapply only when the reason does", async () => {
    const o = await owner("Rejected");
    const shopId = await shop(o.userId, "Rejected Studio");
    const appId = await pendingApplication(shopId, o.userId);
    const res = await rejectApplication({
      applicationId: appId,
      adminUserId: admin.userId,
      decisionReason: "not_eligible",
    });
    expect(res.ok).toBe(true);

    sent.length = 0;
    await runEmailOutbox({ batch: 100 });
    const key = affiliateEmailKey("affiliate_rejected", appId);
    const mine = affiliateSends().filter((s) => s.idempotencyKey === key);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe(o.email);
    expect(mine[0]!.text).toContain("isn't a fit for your account right now");
    expect(mine[0]!.text).toMatch(/apply again/i);
  });
});

describe("rewards", () => {
  async function affiliateWithReward(status: string) {
    const o = await owner("Aff");
    const shopId = await shop(o.userId, "Aff Studio");
    const leaky = await owner("Leaky");
    const referredName = `LeakyName ${randomToken(4)}`;
    const referredShopId = await shop(leaky.userId, referredName);
    const now = new Date();
    const { accountId, rewardId } = await runAsOwner(async (tx) => {
      const app = await tx.affiliateApplication.create({
        data: {
          shopId,
          submittedByUserId: o.userId,
          status: "APPROVED",
          audienceDescription: "x",
          promotionPlan: "y",
          ftcAcknowledgedAt: now,
          acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
          acceptedTermsAt: now,
          decidedAt: now,
          decidedByUserId: admin.userId,
          decisionReason: "approved",
        },
        select: { id: true },
      });
      const account = await tx.affiliateAccount.create({
        data: {
          shopId,
          applicationId: app.id,
          code: randomToken(9),
          acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
          policyVersion: AFFILIATE_POLICY_VERSION,
        },
        select: { id: true },
      });
      const attribution = await tx.affiliateReferralAttribution.create({
        data: {
          affiliateAccountId: account.id,
          referredShopId,
          codeUsed: "x",
          source: "link",
          state: "ATTRIBUTED",
          capturedAt: now,
          lockedAt: now,
          claimExpiresAt: new Date(now.getTime() + 86_400_000),
        },
        select: { id: true },
      });
      const reward = await tx.affiliateReward.create({
        data: {
          affiliateAccountId: account.id,
          referredShopId,
          attributionId: attribution.id,
          rewardType: "subscription_credit",
          amountCents: 3499,
          currency: "usd",
          basisPlan: "pro",
          status,
          qualifiedAt: now,
          holdEndsAt: new Date(now.getTime() + 14 * 86_400_000),
          availableAt: status === "AVAILABLE" ? now : null,
          expiresAt: status === "AVAILABLE" ? new Date(now.getTime() + 365 * 86_400_000) : null,
          // The reversed-shape CHECK: a REVERSED row must say when and why.
          reversedAt: status === "REVERSED" ? now : null,
          reversalReason: status === "REVERSED" ? "invoice_refunded" : null,
        },
        select: { id: true },
      });
      return { accountId: account.id, rewardId: reward.id };
    });
    accountIds.push(accountId);
    return { ownerEmail: o.email, accountId, rewardId, referredShopId, referredName };
  }

  it("🔴 'your month off is ready' names the business only by its mask, never by name", async () => {
    const f = await affiliateWithReward("AVAILABLE");
    await runAsOwner((tx) =>
      enqueueAffiliateEmail(tx, {
        kind: "affiliate_reward_available",
        affiliateAccountId: f.accountId,
        subjectId: f.rewardId,
      }),
    );
    sent.length = 0;
    await runEmailOutbox({ batch: 100 });
    const key = affiliateEmailKey("affiliate_reward_available", f.rewardId);
    const mine = affiliateSends().filter((s) => s.idempotencyKey === key);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe(f.ownerEmail);
    expect(mine[0]!.subject).toBe("Your month off is ready");
    expect(mine[0]!.text).toContain(`Business ••••${f.referredShopId.slice(-4)}`);
    expect(mine[0]!.text).not.toContain(f.referredName);
    expect(mine[0]!.html).not.toContain(f.referredName);
    expect(mine[0]!.text).not.toMatch(/\$\s?\d/);
  });

  it("supersedes a 'ready' email whose reward was reversed before the worker got to it", async () => {
    const f = await affiliateWithReward("AVAILABLE");
    await runAsOwner(async (tx) => {
      await enqueueAffiliateEmail(tx, {
        kind: "affiliate_reward_available",
        affiliateAccountId: f.accountId,
        subjectId: f.rewardId,
      });
      await tx.affiliateReward.update({
        where: { id: f.rewardId },
        data: { status: "REVERSED", reversedAt: new Date(), reversalReason: "invoice_refunded" },
      });
    });
    sent.length = 0;
    await runEmailOutbox({ batch: 100 });
    const key = affiliateEmailKey("affiliate_reward_available", f.rewardId);
    expect(affiliateSends().filter((s) => s.idempotencyKey === key)).toHaveLength(0);
    const row = await runAsOwner((tx) => tx.emailIntent.findUnique({ where: { idempotencyKey: key } }));
    expect(row?.status).toBe("SUPERSEDED");
  });

  it("with no provider configured, an intent is suppressed - terminal - not left to blast later", async () => {
    const f = await affiliateWithReward("REVERSED");
    await runAsOwner((tx) =>
      enqueueAffiliateEmail(tx, {
        kind: "affiliate_reward_reversed",
        affiliateAccountId: f.accountId,
        subjectId: f.rewardId,
      }),
    );
    __setSendEmailForTests(undefined); // no stub => "unconfigured" in the test env
    try {
      sent.length = 0;
      await runEmailOutbox({ batch: 100 });
    } finally {
      __setSendEmailForTests(async (input) => {
        sent.push(input);
        return { status: "sent", id: `msg_${randomToken(8)}` };
      });
    }
    const key = affiliateEmailKey("affiliate_reward_reversed", f.rewardId);
    const row = await runAsOwner((tx) => tx.emailIntent.findUnique({ where: { idempotencyKey: key } }));
    expect(row?.status).toBe("SUPPRESSED");
    expect(affiliateSends().filter((s) => s.idempotencyKey === key)).toHaveLength(0);
  });
});
