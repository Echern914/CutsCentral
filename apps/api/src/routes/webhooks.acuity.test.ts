import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * Webhook receiver: per-shop routing + idempotent ingest. We mock the Acuity
 * client so no live API call happens - getAppointment returns a fixture.
 */

// A mutable fixture the mock returns for any appointment id.
const fixture: AcuityAppointment = {
  id: "appt-100",
  firstName: "Sam",
  lastName: "Stone",
  phone: "302-555-0199",
  email: "sam@example.com",
  datetime: "2026-03-01T15:00:00-05:00",
  endTime: "2026-03-01T15:30:00-05:00",
  price: "30.00",
  type: "Haircut",
  canceled: false,
  noShow: false,
};

vi.mock("../acuity/client.js", () => ({
  getAcuityClientForShop: vi.fn(async () => ({
    me: async () => ({ id: "acct" }),
    getAppointment: async () => fixture,
    listAppointments: async () => [fixture],
  })),
  NotConnectedError: class extends Error {},
  AcuityError: class extends Error {},
}));

const { createApp } = await import("../app.js");
const app = createApp();

let userId: string;
let shopA: string;
let secretA: string;
let secretB: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wh-${randomToken(6)}@test.local`, passwordHash: "x", name: "WH" },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "WH A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "WH B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  secretA = a.webhookSecret;
  secretB = b.webhookSecret;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

function postWebhook(secret: string, body: string) {
  return request(app)
    .post(`/webhooks/acuity/${secret}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(body);
}

describe("acuity webhook receiver", () => {
  it("returns 404 for an unknown webhook secret", async () => {
    const res = await postWebhook("not-a-real-secret", "action=scheduled&id=appt-100");
    expect(res.status).toBe(404);
  });

  it("ingests an appointment scoped to the routed shop", async () => {
    const res = await postWebhook(secretA, "action=scheduled&id=appt-100");
    expect(res.status).toBe(200);

    // allow the async ingest (after ack) to settle
    await vi.waitFor(async () => {
      expect(await prisma.visit.count({ where: { shopId: shopA } })).toBe(1);
    });

    const visit = await prisma.visit.findFirst({ where: { shopId: shopA } });
    expect(visit?.acuityAppointmentId).toBe("appt-100");
    expect(visit?.serviceName).toBe("Haircut");

    // No intake consent on the default fixture -> client is NOT textable.
    const client = await prisma.client.findFirst({ where: { shopId: shopA } });
    expect(client?.smsConsentAt).toBeNull();
    expect(client?.smsConsentSource).toBeNull();
  });

  it("is idempotent - re-delivering the same appointment makes no duplicates", async () => {
    await postWebhook(secretA, "action=scheduled&id=appt-100");
    await postWebhook(secretA, "action=changed&id=appt-100");

    await vi.waitFor(async () => {
      expect(await prisma.visit.count({ where: { shopId: shopA } })).toBe(1);
    });
    expect(await prisma.client.count({ where: { shopId: shopA } })).toBe(1);
  });

  it("shop B's secret never writes into shop A", async () => {
    await postWebhook(secretB, "action=scheduled&id=appt-100");
    await vi.waitFor(async () => {
      const b = await prisma.shop.findFirst({ where: { webhookSecret: secretB } });
      expect(await prisma.visit.count({ where: { shopId: b!.id } })).toBe(1);
    });
    // shop A still has exactly its one visit (same acuity id, different tenant)
    expect(await prisma.visit.count({ where: { shopId: shopA } })).toBe(1);
  });

  it("stamps SMS consent from a checked intake checkbox (once, source acuity_intake)", async () => {
    // Fresh shop so we observe a brand-new client's consent state cleanly.
    const c = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "WH C",
        bookingUrl: "https://c.test",
        webhookSecret: randomToken(),
      },
    });
    // Mutate the shared fixture to a NEW appointment id carrying a checked
    // consent checkbox. Restored in a finally so other tests are unaffected.
    const original = { id: fixture.id, forms: fixture.forms };
    fixture.id = "appt-consent";
    fixture.forms = [
      {
        id: 1,
        name: "Intake",
        values: [
          { fieldID: 7, name: "What's your preferred style?", value: "Fade" },
          {
            fieldID: 8,
            name: "I agree to receive appointment reminders and rebooking texts",
            value: "yes",
          },
        ],
      },
    ];
    try {
      await postWebhook(c.webhookSecret, "action=scheduled&id=appt-consent");
      await vi.waitFor(async () => {
        expect(await prisma.client.count({ where: { shopId: c.id } })).toBe(1);
      });
      const client = await prisma.client.findFirst({ where: { shopId: c.id } });
      expect(client?.smsConsentAt).not.toBeNull();
      expect(client?.smsConsentSource).toBe("acuity_intake");
      const firstStamp = client!.smsConsentAt!.getTime();

      // Re-deliver WITHOUT the checkbox: consent must NOT be revoked, and the
      // original timestamp must NOT be overwritten (first consent wins).
      fixture.forms = [
        {
          id: 1,
          name: "Intake",
          values: [{ fieldID: 7, name: "What's your preferred style?", value: "Fade" }],
        },
      ];
      await postWebhook(c.webhookSecret, "action=changed&id=appt-consent");
      // Give the async ingest a beat, then assert nothing changed.
      await vi.waitFor(async () => {
        const again = await prisma.client.findFirst({ where: { shopId: c.id } });
        expect(again?.smsConsentAt?.getTime()).toBe(firstStamp);
      });
      const again = await prisma.client.findFirst({ where: { shopId: c.id } });
      expect(again?.smsConsentSource).toBe("acuity_intake");
    } finally {
      fixture.id = original.id;
      fixture.forms = original.forms;
    }
  });
});
