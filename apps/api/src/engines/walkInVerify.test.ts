import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  CODE_TTL_MS,
  consumeCheckInProof,
  hashCode,
  issueChallenge,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  mintCode,
  PROOF_TTL_MS,
  RESEND_COOLDOWN_MS,
  SHOP_CHALLENGE_CAP,
  verifyChallenge,
} from "./walkInVerify.js";

/**
 * The OTP lifecycle, raced and abused on purpose. Every refusal path must be
 * the SAME refusal - the assertions here compare full outcome objects, not
 * just booleans, so a helpful branch can't sneak in.
 */

let userId: string;
let shopId: string;
let otherShopId: string;
let phoneSeq = 0;

const NOW = new Date("2026-09-02T15:00:00.000Z");

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(4000 + phoneSeq).padStart(4, "0")}`;
}

/** Issue a challenge and hand back the phone + raw code. */
async function issued(shop = shopId, now = NOW) {
  const phone = freshPhone();
  const out = await issueChallenge({ shopId: shop, phone, now });
  expect(out.send).toBe(true);
  if (!out.send) throw new Error("unreachable");
  return { phone, code: out.code };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wv-${randomToken(6)}@test.local`, name: "WV" },
    select: { id: true },
  });
  userId = user.id;
  const mk = async (name: string) =>
    (
      await prisma.shop.create({
        data: {
          ownerId: userId,
          name,
          slug: `wv-${randomToken(5)}`.toLowerCase(),
          webhookSecret: randomToken(),
          timezone: "UTC",
          walkInEnabled: true,
        },
        select: { id: true },
      })
    ).id;
  shopId = await mk("Verify Cuts");
  otherShopId = await mk("Other Cuts");
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("codes", () => {
  it("mintCode is always exactly six digits", () => {
    for (let i = 0; i < 200; i++) expect(mintCode()).toMatch(/^\d{6}$/);
  });

  it("the hash is scope-bound: same code, different shop or phone, different digest", () => {
    expect(hashCode(shopId, "+12125550100", "123456")).not.toBe(
      hashCode(otherShopId, "+12125550100", "123456"),
    );
    expect(hashCode(shopId, "+12125550100", "123456")).not.toBe(
      hashCode(shopId, "+12125550101", "123456"),
    );
  });

  it("only the hash is at rest", async () => {
    const { phone, code } = await issued();
    const row = await prisma.walkInPhoneCode.findUnique({
      where: { shopId_phone: { shopId, phone } },
    });
    expect(row!.codeHash).toBe(hashCode(shopId, phone, code));
    expect(JSON.stringify(row)).not.toContain(code);
  });
});

describe("verify", () => {
  it("the right code succeeds and mints a proof", async () => {
    const { phone, code } = await issued();
    const out = await verifyChallenge({ shopId, phone, code, now: NOW });
    expect(out.verified).toBe(true);
  });

  it("wrong, malformed, expired, replayed and never-issued are ONE refusal", async () => {
    const { phone, code } = await issued();
    const wrong = await verifyChallenge({
      shopId,
      phone,
      code: code === "000000" ? "000001" : "000000",
      now: NOW,
    });
    const malformed = await verifyChallenge({ shopId, phone, code: "12ab56", now: NOW });
    const never = await verifyChallenge({
      shopId,
      phone: freshPhone(),
      code: "123456",
      now: NOW,
    });
    const expired = await verifyChallenge({
      shopId,
      phone,
      code,
      now: new Date(NOW.getTime() + CODE_TTL_MS + 1),
    });
    // Consume it properly, then replay the same (now spent) code.
    const fresh = await issued();
    await verifyChallenge({ shopId, phone: fresh.phone, code: fresh.code, now: NOW });
    const replayed = await verifyChallenge({
      shopId,
      phone: fresh.phone,
      code: fresh.code,
      now: NOW,
    });

    for (const out of [wrong, malformed, never, expired, replayed]) {
      expect(out).toEqual({ verified: false });
    }
  });

  it("a code minted at shop A proves nothing at shop B", async () => {
    const { phone, code } = await issued();
    // Same phone, same code, different shop: no row there, and even a
    // hypothetical row would carry a different scope-bound hash.
    expect(
      await verifyChallenge({ shopId: otherShopId, phone, code, now: NOW }),
    ).toEqual({ verified: false });
  });

  it("MAX_ATTEMPTS locks the challenge - even for the right code afterward", async () => {
    const { phone, code } = await issued();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyChallenge({ shopId, phone, code: "999999", now: NOW });
    }
    expect(await verifyChallenge({ shopId, phone, code, now: NOW })).toEqual({
      verified: false,
    });
  });

  it("🔴 two concurrent correct submissions produce exactly one winner", async () => {
    const { phone, code } = await issued();
    const [a, b] = await Promise.all([
      verifyChallenge({ shopId, phone, code, now: NOW }),
      verifyChallenge({ shopId, phone, code, now: NOW }),
    ]);
    expect([a.verified, b.verified].filter(Boolean)).toHaveLength(1);
  });
});

describe("resend + caps", () => {
  it("the cooldown swallows an immediate resend, then a resend works", async () => {
    const { phone } = await issued();
    const tooSoon = await issueChallenge({ shopId, phone, now: NOW });
    expect(tooSoon).toEqual({ send: false, reason: "cooldown" });
    const later = await issueChallenge({
      shopId,
      phone,
      now: new Date(NOW.getTime() + RESEND_COOLDOWN_MS + 1),
    });
    expect(later.send).toBe(true);
  });

  it("a resend invalidates the previous code and resets attempts", async () => {
    const first = await issued();
    const second = await issueChallenge({
      shopId,
      phone: first.phone,
      now: new Date(NOW.getTime() + RESEND_COOLDOWN_MS + 1),
    });
    expect(second.send).toBe(true);
    if (!second.send) throw new Error("unreachable");
    expect(
      await verifyChallenge({
        shopId,
        phone: first.phone,
        code: first.code,
        now: new Date(NOW.getTime() + RESEND_COOLDOWN_MS + 2),
      }),
    ).toEqual({ verified: false });
    expect(
      (
        await verifyChallenge({
          shopId,
          phone: first.phone,
          code: second.code,
          now: new Date(NOW.getTime() + RESEND_COOLDOWN_MS + 2),
        })
      ).verified,
    ).toBe(true);
  });

  it("per-phone sends cap inside the window", async () => {
    const { phone } = await issued();
    let t = NOW.getTime();
    for (let i = 1; i < MAX_SENDS_PER_WINDOW; i++) {
      t += RESEND_COOLDOWN_MS + 1;
      const out = await issueChallenge({ shopId, phone, now: new Date(t) });
      expect(out.send, `send ${i + 1}`).toBe(true);
    }
    t += RESEND_COOLDOWN_MS + 1;
    expect(await issueChallenge({ shopId, phone, now: new Date(t) })).toEqual({
      send: false,
      reason: "phone_cap",
    });
  });

  it("the per-shop ceiling stops a kiosk minting challenges across many phones", async () => {
    const shop = (
      await prisma.shop.create({
        data: {
          ownerId: userId,
          name: "Cap Cuts",
          slug: `wvc-${randomToken(5)}`.toLowerCase(),
          webhookSecret: randomToken(),
          timezone: "UTC",
          walkInEnabled: true,
        },
        select: { id: true },
      })
    ).id;
    for (let i = 0; i < SHOP_CHALLENGE_CAP; i++) {
      const out = await issueChallenge({ shopId: shop, phone: freshPhone(), now: NOW });
      expect(out.send).toBe(true);
    }
    expect(
      await issueChallenge({ shopId: shop, phone: freshPhone(), now: NOW }),
    ).toEqual({ send: false, reason: "shop_cap" });
  });

  it("cleanup: long-dead rows are swept by the next challenge", async () => {
    const { phone } = await issued();
    // Age the row far past the cleanup horizon.
    await prisma.walkInPhoneCode.update({
      where: { shopId_phone: { shopId, phone } },
      data: { expiresAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) },
    });
    await issueChallenge({ shopId, phone: freshPhone(), now: NOW });
    expect(
      await prisma.walkInPhoneCode.findUnique({
        where: { shopId_phone: { shopId, phone } },
      }),
    ).toBeNull();
  });
});

describe("the check-in proof", () => {
  async function verifiedProof() {
    const { phone, code } = await issued();
    const out = await verifyChallenge({ shopId, phone, code, now: NOW });
    expect(out.verified).toBe(true);
    if (!out.verified) throw new Error("unreachable");
    return { phone, proof: out.proof };
  }

  it("spends exactly once, even under a race", async () => {
    const { phone, proof } = await verifiedProof();
    const [a, b] = await Promise.all([
      consumeCheckInProof({ shopId, phone, proof, now: NOW }),
      consumeCheckInProof({ shopId, phone, proof, now: NOW }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("is bound to the shop AND phone it verified, and expires", async () => {
    const { phone, proof } = await verifiedProof();
    expect(
      await consumeCheckInProof({ shopId: otherShopId, phone, proof, now: NOW }),
    ).toBe(false);
    expect(
      await consumeCheckInProof({ shopId, phone: freshPhone(), proof, now: NOW }),
    ).toBe(false);
    expect(
      await consumeCheckInProof({
        shopId,
        phone,
        proof,
        now: new Date(NOW.getTime() + PROOF_TTL_MS + 1),
      }),
    ).toBe(false);
    // Still unspent after all those refusals? Then the binding refusals
    // really were refusals, not consumption.
    expect(await consumeCheckInProof({ shopId, phone, proof, now: NOW })).toBe(true);
  });
});
