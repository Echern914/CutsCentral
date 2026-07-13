import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __setPushSenderForTests,
  type PushPayload,
} from "../messaging/push.js";
import { runPushReminders } from "./pushReminders.js";

/**
 * Push reminder tiers (24h / 2h): idempotent under double + concurrent runs,
 * per-shop toggles skip WITHOUT stamping, and a near-start booking gets only
 * the 2h reminder (the 24h window's 2h floor).
 */

// A fixed "now" for deterministic window math WITHIN the run, but on a random
// far-future day PER run: the test DB persists across runs, and a constant NOW
// would let stale rows from a previous (or crashed) run wander back into this
// run's reminder windows.
const NOW = new Date(
  Date.now() + (365 + Math.floor(Math.random() * 10_000)) * 24 * 3600_000,
);

let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;

let pushes: PushPayload[] = [];

let seedSeq = 0;

async function seedAppt(opts: {
  startsInHours: number;
  clientId?: string;
}): Promise<string> {
  // A few seconds of per-seed jitter so two same-hour seeds don't trip the
  // (staffId, startsAt) partial-unique double-booking backstop.
  const startsAt = new Date(
    NOW.getTime() + opts.startsInHours * 3600_000 + ++seedSeq * 1000,
  );
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts.clientId ?? clientId,
      firstName: "Marcus",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

async function stamps(id: string) {
  return prisma.appointment.findUnique({
    where: { id },
    select: { reminder24hPushSentAt: true, reminder2hPushSentAt: true },
  });
}

beforeAll(async () => {
  __setPushSenderForTests({
    send: async (_sub, payload) => {
      pushes.push(JSON.parse(payload) as PushPayload);
    },
  });

  const user = await prisma.user.create({
    data: { email: `remind-${randomToken(6)}@test.chairback`, name: "R" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Reminder Cuts",
      slug: `remind-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = service.id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `remind-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
    },
    select: { id: true },
  });
  clientId = client.id;
  await prisma.pushSubscription.create({
    data: {
      shopId,
      clientId,
      kind: "web",
      endpoint: `https://push.test/${randomToken(8)}`,
      p256dh: "k",
      auth: "a",
    },
  });
});

beforeEach(async () => {
  pushes = [];
  // Each test seeds its own appointments; reset the shop toggles to default ON.
  await prisma.shop.update({
    where: { id: shopId },
    data: { pushReminder24hEnabled: true, pushReminder2hEnabled: true },
  });
});

afterAll(async () => {
  __setPushSenderForTests(undefined);
  await prisma.$disconnect();
});

describe("runPushReminders", () => {
  it("sends the right tier per window and never double-sends on a re-run", async () => {
    const in20h = await seedAppt({ startsInHours: 20 }); // 24h tier
    const in90m = await seedAppt({ startsInHours: 1.5 }); // 2h tier ONLY
    // Far enough out to stay outside every window ANY test in this file runs
    // (the "later" run in the next test is NOW+18.5h; 60h is still 41.5h out).
    const in40h = await seedAppt({ startsInHours: 60 });

    const sent = await runPushReminders(NOW);
    expect(sent).toBe(2);

    const s20 = await stamps(in20h);
    expect(s20!.reminder24hPushSentAt).not.toBeNull();
    expect(s20!.reminder2hPushSentAt).toBeNull();
    // The near-start booking got ONLY the 2h reminder - no back-to-back buzz.
    const s90 = await stamps(in90m);
    expect(s90!.reminder24hPushSentAt).toBeNull();
    expect(s90!.reminder2hPushSentAt).not.toBeNull();
    const s40 = await stamps(in40h);
    expect(s40!.reminder24hPushSentAt).toBeNull();
    expect(s40!.reminder2hPushSentAt).toBeNull();

    expect(pushes).toHaveLength(2);
    expect(pushes.every((p) => p.title.startsWith("Reminder:"))).toBe(true);

    // Idempotent: the same instant re-run sends nothing.
    const again = await runPushReminders(NOW);
    expect(again).toBe(0);
    expect(pushes).toHaveLength(2);
  });

  it("a 24h-reminded appointment still gets its 2h reminder later", async () => {
    const appt = await seedAppt({ startsInHours: 20 });
    await runPushReminders(NOW);
    expect((await stamps(appt))!.reminder24hPushSentAt).not.toBeNull();

    // 18.5 hours later the appointment is 90 minutes out. (Other appointments
    // from the previous test drift into windows too - assert on THIS one's
    // collapse tag, not the global push count.)
    const later = new Date(NOW.getTime() + 18.5 * 3600_000);
    pushes = [];
    await runPushReminders(later);
    const s = await stamps(appt);
    expect(s!.reminder2hPushSentAt).not.toBeNull();
    expect(pushes.filter((p) => p.tag === `reminder-${appt}`)).toHaveLength(1);
  });

  it("skips a toggled-off tier WITHOUT stamping, so re-enabling still sends", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { pushReminder24hEnabled: false },
    });
    const appt = await seedAppt({ startsInHours: 20 });

    await runPushReminders(NOW);
    expect((await stamps(appt))!.reminder24hPushSentAt).toBeNull();
    expect(pushes).toHaveLength(0);

    await prisma.shop.update({
      where: { id: shopId },
      data: { pushReminder24hEnabled: true },
    });
    await runPushReminders(NOW);
    expect((await stamps(appt))!.reminder24hPushSentAt).not.toBeNull();
    expect(pushes).toHaveLength(1);
  });

  it("two concurrent runs claim each stamp exactly once", async () => {
    await seedAppt({ startsInHours: 20 });
    await seedAppt({ startsInHours: 1 });

    const [a, b] = await Promise.all([
      runPushReminders(NOW),
      runPushReminders(NOW),
    ]);
    // Each of the 2 reminders was sent by exactly one of the racers.
    expect(a + b).toBe(2);
    expect(pushes).toHaveLength(2);
  });
});
