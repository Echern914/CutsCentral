import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";
import { encodeSlotId, makeToolExecutor, type ToolContext } from "./tools.js";

/**
 * THE RECEPTIONIST HOLDS A CLIENT TO THE SHOP'S CHANGE RULES
 * (config/customerChangeRules.ts) - the same rule the manage link enforces
 * (routes/customerChangeRules.test.ts).
 *
 *  - cancel / reschedule by text refuse when the shop takes no such change
 *    from clients, or it is too close to the start; nothing is touched, no fee
 *    is quoted, and the model is told to hand it to the shop;
 *  - outside the rules they work as before;
 *  - book_appointment on a LIVE hold re-checks the shop's minimum notice: the
 *    hold was placed while the time was still far enough out, but the notice
 *    moves with the clock.
 */

const NOW = new Date("2026-06-01T16:00:00Z"); // Monday, 12:00 EDT
const HOUR = 3_600_000;

let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;
const PHONE = "+15551239901";

const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send() {
    return { sid: "SMx", status: "queued" };
  },
};
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

const ctxAt = (now: Date): ToolContext => ({
  shopId,
  conversationId: `convo-rules-${clientId}`,
  phone: PHONE,
  clientId,
  now,
});

async function booked(startsAt: Date): Promise<string> {
  const row = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Marcus",
      phone: PHONE,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 35,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return row.id;
}

const rowOf = (id: string) =>
  prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true, startsAt: true } });
const setRules = (data: Record<string, unknown>) => prisma.shop.update({ where: { id: shopId }, data });

beforeAll(async () => {
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  userId = (
    await prisma.user.create({
      data: { email: `rules-tools-${randomToken(6)}@test.chairback`, name: "Rules" },
      select: { id: true },
    })
  ).id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Text Rule Cuts",
        slug: `textrule-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        bookingMode: "native",
        compAccess: true,
        bookingLeadMinutes: 120,
        rescheduleCutoffHours: 0,
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Drick" } })).id;
  serviceId = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 35 } })).id;
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({ data: { shopId, staffId, weekday, startMin: 0, endMin: 1439 } });
  }
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  clientId = (
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `k-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Marcus",
        phone: PHONE,
        smsConsentAt: NOW,
        source: "manual",
      },
      select: { id: true },
    })
  ).id;
});

afterEach(async () => {
  await setRules({
    customerCanReschedule: true,
    customerCanCancel: true,
    cancelCutoffHours: 0,
    rescheduleCutoffHours: 0,
  });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("cancel by text", () => {
  it("🔴 a shop that takes no cancels from clients: refused, nothing touched, hand it to the shop", async () => {
    await setRules({ customerCanCancel: false });
    const id = await booked(new Date("2026-06-05T15:00:00Z"));
    const res = await makeToolExecutor(ctxAt(NOW))("cancel", { appointment_id: id });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("escalate_to_human");
    expect(res.result).toContain("Nothing was cancelled");
    expect(res.result).toContain("clients can't cancel an appointment themselves");
    // No fee is quoted for a cancel that didn't happen.
    expect(res.result).not.toMatch(/fee_cents|\$\d/);
    expect((await rowOf(id)).status).toBe("BOOKED");
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("🔴 inside the cancel cutoff: refused; outside it: cancelled", async () => {
    await setRules({ cancelCutoffHours: 12 });
    const inside = await booked(new Date(NOW.getTime() + 11 * HOUR));
    const refused = await makeToolExecutor(ctxAt(NOW))("cancel", { appointment_id: inside });
    expect(refused.isError).toBe(true);
    expect(refused.result).toContain("too late to cancel it by text");
    expect(refused.result).toContain("up to 12 hours before");
    expect((await rowOf(inside)).status).toBe("BOOKED");

    // Exactly 12 hours out is still the client's to cancel.
    const edge = await booked(new Date(NOW.getTime() + 12 * HOUR));
    const ok = await makeToolExecutor(ctxAt(NOW))("cancel", { appointment_id: edge });
    expect(ok.isError).toBe(false);
    expect((await rowOf(edge)).status).toBe("CANCELED");
  });
});

describe("reschedule by text", () => {
  it("🔴 a shop that takes no reschedules from clients: refused, nothing moves", async () => {
    await setRules({ customerCanReschedule: false });
    const at = new Date("2026-06-06T15:00:00Z");
    const id = await booked(at);
    const res = await makeToolExecutor(ctxAt(NOW))("reschedule", {
      appointment_id: id,
      new_slot_id: encodeSlotId(staffId, serviceId, new Date("2026-06-06T17:00:00Z")),
    });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("escalate_to_human");
    expect(res.result).toContain("Nothing moved");
    const row = await rowOf(id);
    expect(row.status).toBe("BOOKED");
    expect(row.startsAt.toISOString()).toBe(at.toISOString());
  });

  it("switched on, it moves as before", async () => {
    const id = await booked(new Date("2026-06-07T15:00:00Z"));
    const to = new Date("2026-06-07T17:00:00Z");
    const res = await makeToolExecutor(ctxAt(NOW))("reschedule", {
      appointment_id: id,
      new_slot_id: encodeSlotId(staffId, serviceId, to),
    });
    expect(res.isError).toBe(false);
    expect((await rowOf(id)).startsAt.toISOString()).toBe(to.toISOString());
  });
});

describe("book_appointment on a live hold", () => {
  it("🔴 re-checks the minimum notice: a hold placed in time can't book once the notice has passed it", async () => {
    // 2-hour notice: at 16:00Z the 18:00Z slot is exactly bookable.
    const slot = encodeSlotId(staffId, serviceId, new Date("2026-06-01T18:00:00Z"));
    const held = await makeToolExecutor(ctxAt(NOW))("hold_slot", { slot_id: slot });
    expect(held.isError).toBe(false);
    const holdId = JSON.parse(held.result).hold_id as string;

    // One minute later the hold is still live, but 18:00Z is inside the notice.
    const later = new Date(NOW.getTime() + 60_000);
    const res = await makeToolExecutor(ctxAt(later))("book_appointment", { slot_id: slot });
    expect(res.isError).toBe(true);
    expect(res.result).toContain("minimum notice");
    expect((await rowOf(holdId)).status).toBe("PENDING");
  });

  it("a hold still clear of the notice books as before", async () => {
    const slot = encodeSlotId(staffId, serviceId, new Date("2026-06-02T18:00:00Z"));
    const held = await makeToolExecutor(ctxAt(NOW))("hold_slot", { slot_id: slot });
    expect(held.isError).toBe(false);
    const res = await makeToolExecutor(ctxAt(new Date(NOW.getTime() + 60_000)))("book_appointment", {
      slot_id: slot,
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.result).appointment_id).toBeTruthy();
  });
});
