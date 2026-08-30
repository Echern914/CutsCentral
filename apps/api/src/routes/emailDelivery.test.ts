import request from "supertest";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { verifySvixSignature } from "./webhooks.resend.js";
import {
  applyEmailEvent,
  readEmailDeliverySummary,
} from "../services/emailDelivery.js";

/**
 * Email delivery observability.
 *
 * The gap this closes: a send was fire-and-forget, so inbox, spam and hard
 * bounce were indistinguishable from inside ChairBack. The contract is that a
 * provider event lands on the right record, is idempotent under retry, never
 * lets a late success bury a bounce, and leaks nothing from a payload that
 * contains the recipient's address and the rendered subject.
 */

const app = createApp();
const SECRET = "whsec_" + Buffer.from("supersecretwebhookkey0123").toString("base64");
const emails: string[] = [];

function signed(body: object, over: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const id = `msg_${randomToken(6)}`;
  const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((over.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { raw, id, ts, sig: `v1,${sig}` };
}

const post = (body: object, over: { secret?: string; ts?: number; sig?: string } = {}) => {
  const s = signed(body, over);
  return request(app)
    .post("/webhooks/resend")
    .set("Content-Type", "application/json")
    .set("svix-id", s.id)
    .set("svix-timestamp", s.ts)
    .set("svix-signature", over.sig ?? s.sig)
    .send(s.raw);
};

async function seed(messageId: string, kind = "confirmation"): Promise<void> {
  await prisma.emailDelivery.create({
    data: { messageId, kind, status: "sent" },
  });
}

beforeAll(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

afterEach(async () => {
  await prisma.emailDelivery.deleteMany({ where: { messageId: { in: emails } } });
  emails.length = 0;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

afterAll(async () => {
  delete process.env.RESEND_WEBHOOK_SECRET;
  await prisma.$disconnect();
});

describe("signature verification", () => {
  it("accepts a correctly signed payload", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const res = await post({ type: "email.delivered", data: { email_id: id } });
    expect(res.status).toBe(200);
  });

  it("refuses a wrong secret, a tampered body and a missing header", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const body = { type: "email.bounced", data: { email_id: id } };

    const wrongSecret = "whsec_" + Buffer.from("thewrongkey00000000000000").toString("base64");
    expect((await post(body, { secret: wrongSecret })).status).toBe(401);
    expect((await post(body, { sig: "v1,bm90YXNpZ25hdHVyZQ==" })).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/webhooks/resend")
          .set("Content-Type", "application/json")
          .send(JSON.stringify(body))
      ).status,
    ).toBe(401);

    // Refused means UNAPPLIED - a forged bounce must not mark a real send bad.
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("sent");
  });

  it("refuses a replayed timestamp outside the tolerance", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const old = Math.floor(Date.now() / 1000) - 60 * 60;
    expect((await post({ type: "email.delivered", data: { email_id: id } }, { ts: old })).status).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    expect((await post({ type: "email.delivered", data: { email_id: id } })).status).toBe(401);
  });

  it("accepts any signature in the list, so a secret rotation does not drop events", () => {
    const raw = Buffer.from(JSON.stringify({ hello: "world" }));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const good = createHmac("sha256", key).update(`id1.100.`).update(raw).digest("base64");
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: "id1",
        timestamp: "100",
        signature: `v1,bm9wZQ== v1,${good}`,
        body: raw,
        now: new Date(100 * 1000),
      }),
    ).toBe(true);
  });
});

describe("applying events", () => {
  it("moves a send to delivered", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("classifies a bounce and a complaint with fixed vocabulary", async () => {
    for (const [event, status, cls] of [
      ["email.bounced", "bounced", "hard_bounce"],
      ["email.complained", "complained", "complaint"],
    ] as const) {
      const id = `em_${randomToken(8)}`;
      emails.push(id);
      await seed(id);
      await post({ type: event, data: { email_id: id } });
      const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      expect(row!.status).toBe(status);
      expect(row!.failureClass).toBe(cls);
      expect(row!.failedAt).not.toBeNull();
    }
  });

  it("🔴 never lets a late 'delivered' bury a bounce", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.bounced", data: { email_id: id } });
    await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced"); // bad news survives
    expect(row!.eventCount).toBe(2); // but the event is still counted
  });

  it("is idempotent - a retried webhook changes nothing but the count", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    for (let i = 0; i < 3; i++) await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.eventCount).toBe(3);
  });

  it("acks an event for a message it never recorded", async () => {
    const res = await post({ type: "email.delivered", data: { email_id: "em_never_seen" } });
    expect(res.status).toBe(200);
    expect(await applyEmailEvent({ messageId: "em_never_seen", event: "email.delivered" })).toBe(
      "unknown_message",
    );
  });

  it("ignores an event type outside the vocabulary", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    expect(await applyEmailEvent({ messageId: id, event: "email.opened" })).toBe("ignored");
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("sent");
  });

  it("acks a malformed body from a correctly signed sender", async () => {
    const s = signed({});
    const raw = "{not json";
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", key).update(`${s.id}.${s.ts}.${raw}`).digest("base64");
    const res = await request(app)
      .post("/webhooks/resend")
      .set("Content-Type", "application/json")
      .set("svix-id", s.id)
      .set("svix-timestamp", s.ts)
      .set("svix-signature", `v1,${sig}`)
      .send(raw);
    expect(res.status).toBe(200); // do not make Resend retry forever
  });
});

describe("what the ledger and its logs may contain", () => {
  it("stores no address, subject or body", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({
      type: "email.bounced",
      data: {
        email_id: id,
        to: ["casey@example.com"],
        subject: "Booking confirmed: Skin Fade at Drick's",
        text: "the whole rendered body",
      },
    });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    const flat = JSON.stringify(row);
    expect(flat).not.toContain("casey@example.com");
    expect(flat).not.toContain("Skin Fade");
    expect(flat).not.toContain("rendered body");
  });

  it("logs the event name and outcome only - never the payload", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      await post({
        type: "email.delivered",
        data: { email_id: id, to: ["casey@example.com"], subject: "Skin Fade" },
      });
      const logged = JSON.stringify(infoSpy.mock.calls);
      expect(logged).not.toContain("casey@example.com");
      expect(logged).not.toContain("Skin Fade");
      expect(logged).toContain("email.delivered");
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("the admin summary", () => {
  it("counts by status and by kind", async () => {
    const ids = [`em_${randomToken(8)}`, `em_${randomToken(8)}`, `em_${randomToken(8)}`];
    emails.push(...ids);
    await seed(ids[0]!, "confirmation");
    await seed(ids[1]!, "confirmation");
    await seed(ids[2]!, "cancellation");
    await post({ type: "email.bounced", data: { email_id: ids[1]! } });

    const summary = await readEmailDeliverySummary(new Date(), 7);
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.byKind["confirmation"]!.bounced).toBeGreaterThanOrEqual(1);
    expect(summary.byStatus["bounced"]).toBeGreaterThanOrEqual(1);
  });
});
