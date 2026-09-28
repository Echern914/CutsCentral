import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import { runRebookNudges } from "./rebookNudges.js";

/**
 * The "book your next one?" push, ~30 min after the chair empties.
 *
 * The cases that actually matter here are the ones that would embarrass the
 * shop rather than the ones that prove the happy path:
 *   - the LOOK-BACK FLOOR. Without it the very deploy that adds the stamp
 *     column finds every completed haircut in history sitting at null and
 *     notifies all of them at once.
 *   - SYNCED shops. Acuity/Square shops have Visit rows and no Appointment row
 *     at all, so an engine reading only Appointment reaches none of them (#212).
 *   - and the twin of that: a promoted native booking exists as BOTH an
 *     Appointment and a Visit, and must produce exactly ONE nudge.
 *   - never a no-show or a cancellation, and never someone who already rebooked.
 */

// Fixed "now" per run, on a random far-future day: the test DB persists between
// runs and a constant NOW would let stale rows wander into this run's window.
const NOW = new Date(
  Date.now() + (365 + Math.floor(Math.random() * 10_000)) * 24 * 3600_000,
);
const MIN = 60_000;

let shopId: string;
let staffId: string;
let serviceId: string;
let pushes: PushPayload[] = [];
let seedSeq = 0;

/** A fresh client each time: the engine skips clients who already rebooked, so
 *  sharing one client across seeds would silently suppress later candidates. */
async function makeClient(): Promise<string> {
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `rebook-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Marcus",
    },
    select: { id: true },
  });
  await prisma.pushSubscription.create({
    data: {
      shopId,
      clientId: client.id,
      kind: "web",
      endpoint: `https://push.test/${randomToken(8)}`,
      p256dh: "k",
      auth: "a",
    },
  });
  return client.id;
}

/** An appointment that ENDED `endedMinAgo` minutes before NOW. */
async function seedAppt(opts: {
  endedMinAgo: number;
  clientId: string;
  // A literal union, NOT `string`: Railway's build runs `tsc` over the test
  // files too and is stricter than vitest, which transpiles without checking
  // types. A plain `string` here compiles and passes locally, then fails the
  // production build.
  status?: "PENDING" | "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
  canceledAt?: Date;
}): Promise<string> {
  const endsAt = new Date(NOW.getTime() - opts.endedMinAgo * MIN + ++seedSeq * 1000);
  const startsAt = new Date(endsAt.getTime() - 30 * MIN);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts.clientId,
      firstName: "Marcus",
      status: opts.status ?? "BOOKED",
      canceledAt: opts.canceledAt ?? null,
      startsAt,
      endsAt,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

/** A SYNCED visit (Acuity/Square) that ended `endedMinAgo` minutes before NOW. */
async function seedVisit(opts: {
  endedMinAgo: number;
  clientId: string;
  noShow?: boolean;
}): Promise<string> {
  const endAt = new Date(NOW.getTime() - opts.endedMinAgo * MIN + ++seedSeq * 1000);
  const visit = await prisma.visit.create({
    data: {
      shopId,
      clientId: opts.clientId,
      acuityAppointmentId: `acuity-${randomToken(8)}`,
      status: "COMPLETED",
      noShow: opts.noShow ?? false,
      scheduledAt: new Date(endAt.getTime() - 30 * MIN),
      endAt,
      serviceName: "Fade",
    },
    select: { id: true },
  });
  return visit.id;
}

/** A SYNCED booking two weeks after NOW, in the status the sync left it. */
async function seedUpcomingVisit(
  clientId: string,
  status: "SCHEDULED" | "RESCHEDULED" | "CANCELED",
): Promise<void> {
  const scheduledAt = new Date(NOW.getTime() + 14 * 24 * 3600_000);
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acuity-${randomToken(8)}`,
      status,
      canceledAt: status === "CANCELED" ? NOW : null,
      scheduledAt,
      endAt: new Date(scheduledAt.getTime() + 30 * MIN),
      serviceName: "Fade",
    },
  });
}

const apptStamp = (id: string) =>
  prisma.appointment.findUnique({ where: { id }, select: { rebookPromptSentAt: true } });
const visitStamp = (id: string) =>
  prisma.visit.findUnique({ where: { id }, select: { rebookPromptSentAt: true } });

beforeAll(async () => {
  __setPushSenderForTests({
    send: async (_sub, payload) => {
      pushes.push(JSON.parse(payload) as PushPayload);
    },
  });
  const user = await prisma.user.create({
    data: { email: `rebook-${randomToken(6)}@test.chairback`, name: "R" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Rebook Cuts",
      slug: `rebook-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = service.id;
});

beforeEach(async () => {
  pushes = [];
  await prisma.shop.update({ where: { id: shopId }, data: { rebookPushEnabled: true } });
});

afterAll(async () => {
  __setPushSenderForTests(undefined);
  const user = await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  if (user) await prisma.user.deleteMany({ where: { id: user.ownerId } });
  await prisma.$disconnect();
});

describe("runRebookNudges", () => {
  it("nudges a finished cut, not one that just ended, and never twice", async () => {
    const ready = await seedAppt({ endedMinAgo: 45, clientId: await makeClient() });
    // Ended 10 minutes ago: the client is still in the chair paying. Too soon.
    const tooSoon = await seedAppt({ endedMinAgo: 10, clientId: await makeClient() });

    expect(await runRebookNudges(NOW)).toBe(1);
    expect((await apptStamp(ready))!.rebookPromptSentAt).not.toBeNull();
    expect((await apptStamp(tooSoon))!.rebookPromptSentAt).toBeNull();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toContain("Cut");

    // Re-run: the stamp is the at-most-once guard.
    pushes = [];
    expect(await runRebookNudges(NOW)).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("does NOT reach back past the look-back floor", async () => {
    // THE DEPLOY GUARD. Every pre-existing row has a null stamp, so without the
    // floor the first run after the migration would notify the shop's whole
    // history at once. 10 hours ago is well past the 6h floor.
    const ancient = await seedAppt({ endedMinAgo: 10 * 60, clientId: await makeClient() });
    expect(await runRebookNudges(NOW)).toBe(0);
    expect((await apptStamp(ancient))!.rebookPromptSentAt).toBeNull();
    expect(pushes).toHaveLength(0);
  });

  it("never nudges a cancellation or a no-show", async () => {
    const canceled = await seedAppt({
      endedMinAgo: 45,
      clientId: await makeClient(),
      status: "CANCELED",
      canceledAt: new Date(NOW.getTime() - 60 * MIN),
    });
    const noShow = await seedAppt({
      endedMinAgo: 45,
      clientId: await makeClient(),
      status: "NO_SHOW",
    });
    const visitNoShow = await seedVisit({
      endedMinAgo: 45,
      clientId: await makeClient(),
      noShow: true,
    });

    expect(await runRebookNudges(NOW)).toBe(0);
    expect((await apptStamp(canceled))!.rebookPromptSentAt).toBeNull();
    expect((await apptStamp(noShow))!.rebookPromptSentAt).toBeNull();
    expect((await visitStamp(visitNoShow))!.rebookPromptSentAt).toBeNull();
    expect(pushes).toHaveLength(0);
  });

  it("skips a client who already booked their next one", async () => {
    const clientId = await makeClient();
    const done = await seedAppt({ endedMinAgo: 45, clientId });
    // They rebooked at the counter on the way out - asking again is noise.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId,
        firstName: "Marcus",
        status: "BOOKED",
        startsAt: new Date(NOW.getTime() + 14 * 24 * 3600_000),
        endsAt: new Date(NOW.getTime() + 14 * 24 * 3600_000 + 30 * MIN),
        manageToken: randomToken(),
      },
    });

    expect(await runRebookNudges(NOW)).toBe(0);
    // Not stamped either: if they later cancel that booking they become
    // eligible again while still inside the window.
    expect((await apptStamp(done))!.rebookPromptSentAt).toBeNull();
  });

  it("skips a client whose next one was booked in Acuity or Square", async () => {
    // A synced shop's next booking arrives as a Visit, never an Appointment,
    // so checking Appointment alone asked them to book what they already had.
    const booked = await makeClient();
    const moved = await makeClient();
    const doneBooked = await seedVisit({ endedMinAgo: 45, clientId: booked });
    const doneMoved = await seedVisit({ endedMinAgo: 45, clientId: moved });
    await seedUpcomingVisit(booked, "SCHEDULED");
    // A reschedule moves the same row to its new time: still booked.
    await seedUpcomingVisit(moved, "RESCHEDULED");

    expect(await runRebookNudges(NOW)).toBe(0);
    expect(pushes).toHaveLength(0);
    // Unstamped, like the native case above.
    expect((await visitStamp(doneBooked))!.rebookPromptSentAt).toBeNull();
    expect((await visitStamp(doneMoved))!.rebookPromptSentAt).toBeNull();
  });

  it("still nudges a client whose synced next booking was canceled", async () => {
    const clientId = await makeClient();
    const done = await seedVisit({ endedMinAgo: 45, clientId });
    await seedUpcomingVisit(clientId, "CANCELED");

    expect(await runRebookNudges(NOW)).toBe(1);
    expect((await visitStamp(done))!.rebookPromptSentAt).not.toBeNull();
  });

  it("nudges SYNCED visits, which have no Appointment row at all", async () => {
    // The #212 lesson: Acuity/Square shops live entirely in Visit.
    const visitId = await seedVisit({ endedMinAgo: 45, clientId: await makeClient() });
    expect(await runRebookNudges(NOW)).toBe(1);
    expect((await visitStamp(visitId))!.rebookPromptSentAt).not.toBeNull();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toContain("Fade");
  });

  it("sends ONE nudge for a native booking that was promoted to a Visit", async () => {
    // A completed native booking exists as BOTH rows. Nudging both would buzz
    // the client twice for one haircut.
    const clientId = await makeClient();
    const visitId = await seedVisit({ endedMinAgo: 45, clientId });
    const apptId = await seedAppt({ endedMinAgo: 45, clientId });
    await prisma.appointment.update({ where: { id: apptId }, data: { visitId } });

    expect(await runRebookNudges(NOW)).toBe(1);
    expect(pushes).toHaveLength(1);
    // The Appointment is the one that speaks; the linked Visit stays silent.
    expect((await apptStamp(apptId))!.rebookPromptSentAt).not.toBeNull();
    expect((await visitStamp(visitId))!.rebookPromptSentAt).toBeNull();
  });

  it("a shop with the toggle off is skipped WITHOUT stamping", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { rebookPushEnabled: false } });
    const id = await seedAppt({ endedMinAgo: 45, clientId: await makeClient() });

    expect(await runRebookNudges(NOW)).toBe(0);
    // Unstamped on purpose: turning the feature on later must still reach
    // anyone whose window is still open.
    expect((await apptStamp(id))!.rebookPromptSentAt).toBeNull();

    await prisma.shop.update({ where: { id: shopId }, data: { rebookPushEnabled: true } });
    expect(await runRebookNudges(NOW)).toBe(1);
    expect((await apptStamp(id))!.rebookPromptSentAt).not.toBeNull();
  });
});

/**
 * WHERE THE TAP GOES. The push used to deep-link to /book/<slug> for every shop,
 * which is a dead end for a shop that books through Acuity; and a shop that
 * switched to ChairBack booking keeps its old Acuity link saved, which must not
 * win. Both follow the shared rule (config/bookingLinks.ts).
 */
describe("the rebook push lands where the shop takes bookings now", () => {
  const ACUITY_LINK = "https://rebook-studio.as.me/schedule.php";
  const restore = () =>
    prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "native", bookingUrl: null, publicPageEnabled: true },
    });

  it("a shop on ChairBack booking lands on its booking page, not the old Acuity link", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { bookingUrl: ACUITY_LINK } });
    try {
      await seedAppt({ endedMinAgo: 45, clientId: await makeClient() });
      expect(await runRebookNudges(NOW)).toBe(1);
      const slug = (await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).slug;
      expect(pushes[0]!.url).toMatch(new RegExp(`/book/${slug}$`));
    } finally {
      await restore();
    }
  });

  it("a shop booking through Acuity lands on its Acuity link, not a /book/ 404", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "acuity", bookingUrl: ACUITY_LINK },
    });
    try {
      await seedVisit({ endedMinAgo: 45, clientId: await makeClient() });
      expect(await runRebookNudges(NOW)).toBe(1);
      expect(pushes[0]!.url).toBe(ACUITY_LINK);
    } finally {
      await restore();
    }
  });

  it("with nowhere to book online, lands on the customer's own rewards page - never ChairBack's home", async () => {
    // A synced shop that never saved its Acuity link - common enough that the
    // dashboard has a prompt for it.
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "acuity", bookingUrl: null },
    });
    try {
      const clientId = await makeClient();
      await seedVisit({ endedMinAgo: 45, clientId });
      expect(await runRebookNudges(NOW)).toBe(1);
      const { magicToken } = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(pushes[0]!.url).toMatch(new RegExp(`/r/${magicToken}$`));
    } finally {
      await restore();
    }
  });
});
