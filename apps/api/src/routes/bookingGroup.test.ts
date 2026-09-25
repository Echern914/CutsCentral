import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { shopDayAhead } from "../testing/shopDay.js";
import { raceBehindAdvisoryLock, winners } from "../testing/raceBarrier.js";

/**
 * Booking a party: one to three people, back to back, with the same barber.
 *
 * The property under test throughout is ALL OR NOTHING. A group that half
 * commits is worse than a refusal: it tells a family to turn up and then does
 * not have a chair for one of them.
 */
const app = createApp();
const TZ = "America/New_York";
/**
 * 🔴 A week out, counted from NOW, never a literal date. A hard-coded day
 * passes for weeks and then fails on every branch the morning it goes by -
 * with the API rightly calling the booking too soon.
 */
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
/** Shop-local 2:00 PM on that day. */
const at = (minutesFromMidnight: number) =>
  zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, minutesFromMidnight, TZ);
const TWO_PM = at(14 * 60);

let userId: string;
let slug: string;
let shopId: string;
let staffId: string;
let cutId: string;
let kidsId: string;
let beardId: string;

/** A second shop, for the tenant-isolation tests. */
let otherUserId: string;
let otherSlug: string;
let otherShopId: string;

async function makeShop(prefix: string) {
  const email = `${prefix}-${randomToken(6)}@test.chairback`.toLowerCase();
  const user = await prisma.user.create({ data: { email, name: "G" }, select: { id: true } });
  const theSlug = `${prefix}-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Group Cuts",
      slug: theSlug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 2,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  const staff = await prisma.staff.create({
    data: { shopId: shop.id, name: "Sam" },
    select: { id: true },
  });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
  return { userId: user.id, slug: theSlug, shopId: shop.id, staffId: staff.id };
}

async function makeService(
  shop: string,
  staff: string,
  name: string,
  durationMin: number,
  price: number | null,
) {
  const svc = await prisma.service.create({
    data: { shopId: shop, name, durationMin, price },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId: shop, serviceId: svc.id, staffId: staff },
  });
  return svc.id;
}

beforeAll(async () => {
  const main = await makeShop("grp");
  userId = main.userId;
  slug = main.slug;
  shopId = main.shopId;
  staffId = main.staffId;
  cutId = await makeService(shopId, staffId, "Haircut", 30, 40);
  kidsId = await makeService(shopId, staffId, "Kids cut", 20, 25);
  beardId = await makeService(shopId, staffId, "Beard trim", 15, 15);

  const other = await makeShop("oth");
  otherUserId = other.userId;
  otherSlug = other.slug;
  otherShopId = other.shopId;
});

beforeEach(async () => {
  // Each test starts on an empty calendar; the day is shared.
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  for (const id of [userId, otherUserId]) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

const booker = { firstName: "Eric", lastName: "Chern", phone: "+12015550134", email: "eric@test.chairback" };

const createGroup = (
  attendees: Array<{ firstName: string; serviceId: string }>,
  extra: Record<string, unknown> = {},
  startsAt: Date = TWO_PM,
) =>
  request(app)
    .post(`/api/book/${slug}/group`)
    .send({ staffId, startsAt: startsAt.toISOString(), attendees, ...booker, ...extra });

/** Everything on the barber calendar for the shared day, in order. */
const calendar = () =>
  prisma.appointment.findMany({
    where: { shopId },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      firstName: true,
      startsAt: true,
      endsAt: true,
      status: true,
      groupId: true,
      groupPosition: true,
      priceAtBooking: true,
      service: { select: { name: true } },
    },
  });

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);

describe("🔴 the booker can be told apart: a last name or an Instagram handle", () => {
  const party = () => [
    { firstName: "Eric", serviceId: cutId },
    { firstName: "Brother", serviceId: kidsId },
  ];
  const bookerClient = () =>
    prisma.client.findFirst({
      where: { shopId, phone: booker.phone },
      select: { lastName: true, instagram: true },
    });

  it("a first name alone is refused before anything is written", async () => {
    const res = await createGroup(party(), { lastName: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "name_or_instagram_required",
      message: "Add your last name or Instagram so the shop can tell you apart",
    });
    expect(await calendar()).toHaveLength(0);
  });

  it("an Instagram handle alone books, and the client carries it bare and lowercase", async () => {
    const res = await createGroup(party(), { lastName: undefined, instagram: "  @Eric.CHERN " });
    expect(res.status).toBe(201);
    expect(await bookerClient()).toMatchObject({ instagram: "eric.chern" });
  });

  it("a last name alone books", async () => {
    const res = await createGroup(party(), { lastName: "Chern", instagram: "" });
    expect(res.status).toBe(201);
    expect((await bookerClient())?.lastName).toBe("Chern");
  });

  it("🔴 a typed phone fills a missing handle but never replaces one on file", async () => {
    // The form is unauthenticated: anyone who knows a regular's number could
    // otherwise relabel him "@someone.else" on every screen.
    const phone = "+12015550177";
    const regular = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:${phone}`,
        magicToken: randomToken(),
        firstName: "Marcus",
        lastName: "Reed",
        phone,
        instagram: "marcus.reed",
      },
    });
    const res = await createGroup(party(), { phone, email: undefined, instagram: "someone.else" });
    expect(res.status).toBe(201);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: regular.id } })).instagram).toBe("marcus.reed");

    await prisma.client.update({ where: { id: regular.id }, data: { instagram: null } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    const again = await createGroup(party(), { phone, email: undefined, instagram: "marcus.r" });
    expect(again.status).toBe(201);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: regular.id } })).instagram).toBe("marcus.r");
  });

  it("🔴 two contactless Mikes told apart by handle stay two clients", async () => {
    // No phone, no email: the key falls back to the name, and the handle is
    // what the rule accepted as telling them apart - so it is in the key.
    const noContact = { firstName: "Mike", lastName: undefined, phone: undefined, email: undefined };
    const a = await createGroup(party(), { ...noContact, instagram: "mike.a" });
    expect(a.status).toBe(201);
    const b = await createGroup(party(), { ...noContact, instagram: "mike.b" }, at(16 * 60));
    expect(b.status).toBe(201);
    const mikes = await prisma.client.findMany({
      where: { shopId, firstName: "Mike", instagram: { in: ["mike.a", "mike.b"] } },
      select: { instagram: true },
    });
    expect(mikes.map((m) => m.instagram).sort()).toEqual(["mike.a", "mike.b"]);
  });

  it("a handle that cannot be one is refused, even with a last name", async () => {
    const res = await createGroup(party(), { instagram: "eric chern!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_instagram");
    expect(await calendar()).toHaveLength(0);
  });
});

describe("quantity 1 is still an ordinary booking", () => {
  it("🔴 writes exactly ONE appointment, unchanged in every visible way", async () => {
    // The group path must not become a second, subtly different way to book one
    // person. What differs is the group link and nothing else.
    const res = await createGroup([{ firstName: "Eric", serviceId: cutId }]);
    expect(res.status).toBe(201);
    const rows = await calendar();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstName).toBe("Eric");
    expect(rows[0]!.status).toBe("BOOKED");
    expect(hhmm(rows[0]!.startsAt)).toBe("2:00 PM");
    expect(hhmm(rows[0]!.endsAt)).toBe("2:30 PM");
    expect(Number(rows[0]!.priceAtBooking)).toBe(40);
    expect(rows[0]!.groupPosition).toBe(0);
  });
});

describe("two and three attendees sit back to back", () => {
  it("two attendees get consecutive times", async () => {
    const res = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    expect(res.status).toBe(201);
    const rows = await calendar();
    expect(rows.map((r) => [r.firstName, hhmm(r.startsAt), hhmm(r.endsAt)])).toEqual([
      ["Eric", "2:00 PM", "2:30 PM"],
      ["Brother", "2:30 PM", "2:50 PM"],
    ]);
  });

  it("🔴 three different durations produce the right sequence and the right prices", async () => {
    const res = await createGroup([
      { firstName: "Eric", serviceId: cutId }, // 30 / $40
      { firstName: "Brother", serviceId: kidsId }, // 20 / $25
      { firstName: "Dad", serviceId: beardId }, // 15 / $15
    ]);
    expect(res.status).toBe(201);
    const rows = await calendar();
    expect(
      rows.map((r) => [
        r.firstName,
        r.service?.name,
        hhmm(r.startsAt),
        hhmm(r.endsAt),
        Number(r.priceAtBooking),
      ]),
    ).toEqual([
      ["Eric", "Haircut", "2:00 PM", "2:30 PM", 40],
      ["Brother", "Kids cut", "2:30 PM", "2:50 PM", 25],
      ["Dad", "Beard trim", "2:50 PM", "3:05 PM", 15],
    ]);
  });

  it("🔴 each appointment stands ALONE on the barber calendar", async () => {
    // The barber must see three real bookings with three attendee names, not
    // one blob. Every row is an ordinary Appointment carrying its own service,
    // times and price - the group link is extra, never a replacement.
    await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    const rows = await calendar();
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(rows.map((r) => r.groupPosition)).toEqual([0, 1]);
    expect(rows.every((r) => r.status === "BOOKED")).toBe(true);
  });

  it("refuses a fourth attendee", async () => {
    const res = await createGroup([
      { firstName: "A", serviceId: cutId },
      { firstName: "B", serviceId: cutId },
      { firstName: "C", serviceId: cutId },
      { firstName: "D", serviceId: cutId },
    ]);
    expect(res.status).toBe(400);
    expect(await calendar()).toHaveLength(0);
  });
});

describe("🔴 a conflict ANYWHERE in the run creates nothing", () => {
  it.each([
    ["at the very start", 14 * 60],
    ["in the middle, between members", 14 * 60 + 40],
    ["at the very end", 15 * 60],
  ])("%s", async (_label, blockedMin) => {
    // The whole point of the combined-interval check: an obstruction between
    // member 1 and member 2 is invisible to a per-member check that only ever
    // looks at the members' own spans.
    const other = await prisma.staff.findFirst({ where: { shopId }, select: { id: true } });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: other!.id,
        serviceId: cutId,
        firstName: "Existing",
        status: "BOOKED",
        startsAt: at(blockedMin),
        endsAt: at(blockedMin + 10),
        manageToken: randomToken(),
      },
    });

    const res = await createGroup([
      { firstName: "Eric", serviceId: cutId }, // 2:00-2:30
      { firstName: "Brother", serviceId: kidsId }, // 2:30-2:50
      { firstName: "Dad", serviceId: beardId }, // 2:50-3:05
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slot_taken");

    // 🔴 ZERO created. The pre-existing appointment is the only row left.
    const rows = await calendar();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstName).toBe("Existing");
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(0);
  });
});

describe("concurrent submissions", () => {
  it("🔴 two racers for the same slot: exactly one group exists", async () => {
    // A real interleaving, not Promise.all: both racers are parked behind the
    // SAME advisory lock the writer takes (`appt:<staffId>`), and settledEarly
    // proves they were genuinely stuck rather than serialised by the event loop.
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () =>
        createGroup([
          { firstName: "Eric", serviceId: cutId },
          { firstName: "Brother", serviceId: kidsId },
        ]).then((r) => r.status),
      () =>
        createGroup([
          { firstName: "Other", serviceId: cutId },
          { firstName: "Friend", serviceId: kidsId },
        ]).then((r) => r.status),
    ]);
    expect(settledEarly).toBe(0);

    const statuses = winners(results);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(1);
    expect(await calendar()).toHaveLength(2);
  });

  it("🔴 the SAME idempotency key twice yields one group, not two", async () => {
    // A client retrying a request whose response it never saw must get the same
    // group back. The unique index is what settles it; both racers are held
    // behind the writer's own lock so they genuinely contend.
    const key = `idem-${randomToken(8)}`;
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () =>
        createGroup([{ firstName: "Eric", serviceId: cutId }], { idempotencyKey: key }).then(
          (r) => r.body?.groupId as string | undefined,
        ),
      () =>
        createGroup([{ firstName: "Eric", serviceId: cutId }], { idempotencyKey: key }).then(
          (r) => r.body?.groupId as string | undefined,
        ),
    ]);
    expect(settledEarly).toBe(0);

    const ids = winners(results).filter(Boolean);
    expect(ids).toHaveLength(2);
    // 🔴 THE SAME group, and only one set of chairs.
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(1);
    expect(await calendar()).toHaveLength(1);
  });

  it("a plain retry after the fact returns the same group without booking again", async () => {
    const key = `idem-${randomToken(8)}`;
    const first = await createGroup([{ firstName: "Eric", serviceId: cutId }], {
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const again = await createGroup([{ firstName: "Eric", serviceId: cutId }], {
      idempotencyKey: key,
    });
    expect(again.status).toBe(200);
    expect(again.body.retried).toBe(true);
    expect(again.body.groupId).toBe(first.body.groupId);
    expect(await calendar()).toHaveLength(1);
  });
});

describe("🔴 tenant isolation", () => {
  it("another shop cannot read the group", async () => {
    const created = await createGroup([{ firstName: "Eric", serviceId: cutId }]);
    const token = created.body.manageToken as string;
    // The token is the authentication, so the meaningful test is the reverse:
    // a group token from THIS shop must not be usable to reach the other shop,
    // and a staff/service id from the other shop must not be bookable here.
    const cross = await request(app)
      .post(`/api/book/${otherSlug}/group`)
      .send({
        staffId, // this shop's barber
        startsAt: TWO_PM.toISOString(),
        attendees: [{ firstName: "Eric", serviceId: cutId }],
        ...booker,
      });
    expect(cross.status).toBe(400);
    expect(await prisma.appointmentGroup.count({ where: { shopId: otherShopId } })).toBe(0);
    // The original is untouched.
    const view = await request(app).get(`/api/book/group/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.members).toHaveLength(1);
  });

  it("a service from another shop cannot be smuggled into a group", async () => {
    const foreign = await makeService(otherShopId, staffId, "Foreign", 30, 40);
    const res = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: foreign },
    ]);
    expect(res.status).toBe(400);
    expect(await calendar()).toHaveLength(0);
  });

  it("an unknown group token is a 404, and says nothing else", async () => {
    const res = await request(app).get(`/api/book/group/${randomToken()}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("rescheduling the whole group", () => {
  it("🔴 moves every member, keeping them back to back", async () => {
    const created = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    const token = created.body.manageToken as string;

    const moved = await request(app)
      .post(`/api/book/group/${token}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(moved.status).toBe(200);

    const rows = await calendar();
    expect(rows.map((r) => [r.firstName, hhmm(r.startsAt), hhmm(r.endsAt)])).toEqual([
      ["Eric", "4:00 PM", "4:30 PM"],
      ["Brother", "4:30 PM", "4:50 PM"],
    ]);
  });

  it("🔴 a move onto a blocked time moves NOBODY", async () => {
    const created = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    const token = created.body.manageToken as string;
    const before = await calendar();

    // Something else takes the middle of the destination window.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId: cutId,
        firstName: "Existing",
        status: "BOOKED",
        startsAt: at(16 * 60 + 35),
        endsAt: at(16 * 60 + 45),
        manageToken: randomToken(),
      },
    });

    const moved = await request(app)
      .post(`/api/book/group/${token}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(moved.status).toBe(409);

    // Both members are exactly where they were.
    const after = (await calendar()).filter((r) => r.groupId !== null);
    expect(after.map((r) => r.startsAt.toISOString())).toEqual(
      before.map((r) => r.startsAt.toISOString()),
    );
  });

  it("🔴 the group does not collide with ITSELF on an overlapping move", async () => {
    // 2:00-2:50 moving to 2:30-3:20: the destination OVERLAPS the origin. Every
    // member has to be excluded from the conflict check or the run refuses its
    // own rows, and a customer could then only ever make a move large enough to
    // clear the whole visit. This is what excludeAppointmentIds is for.
    const created = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    const token = created.body.manageToken as string;
    const moved = await request(app)
      .post(`/api/book/group/${token}/reschedule`)
      .send({ startsAt: at(14 * 60 + 30).toISOString() });
    expect(moved.status).toBe(200);
    const rows = await calendar();
    expect(rows.map((r) => hhmm(r.startsAt))).toEqual(["2:30 PM", "3:00 PM"]);
  });
});

describe("🔴 cancelling one attendee and cancelling the party are different things", () => {
  it("cancelling ONE leaves the others booked", async () => {
    const created = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
      { firstName: "Dad", serviceId: beardId },
    ]);
    const token = created.body.manageToken as string;
    const view = await request(app).get(`/api/book/group/${token}`);
    const brother = view.body.members.find(
      (m: { firstName: string }) => m.firstName === "Brother",
    );

    // Through that member's OWN manage token - the ordinary single cancel.
    const res = await request(app).post(`/api/book/manage/${brother.manageToken}/cancel`).send({});
    expect(res.status).toBeLessThan(400);

    const rows = await calendar();
    const byName = Object.fromEntries(rows.map((r) => [r.firstName, r.status]));
    expect(byName.Brother).toBe("CANCELED");
    // 🔴 NO ACCIDENTAL SIBLING CANCELLATION. They are still coming.
    expect(byName.Eric).toBe("BOOKED");
    expect(byName.Dad).toBe("BOOKED");
    // And the group itself is still a live visit.
    const group = await prisma.appointmentGroup.findFirst({ where: { shopId } });
    expect(group!.status).toBe("ACTIVE");
  });

  it("cancelling the GROUP cancels everyone", async () => {
    const created = await createGroup([
      { firstName: "Eric", serviceId: cutId },
      { firstName: "Brother", serviceId: kidsId },
    ]);
    const token = created.body.manageToken as string;

    const res = await request(app).post(`/api/book/group/${token}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(2);

    const rows = await calendar();
    expect(rows.every((r) => r.status === "CANCELED")).toBe(true);
    const group = await prisma.appointmentGroup.findFirst({ where: { shopId } });
    expect(group!.status).toBe("CANCELED");
    expect(group!.canceledAt).not.toBeNull();
  });

  it("cancelling an already-cancelled group is a no-op, not an error", async () => {
    const created = await createGroup([{ firstName: "Eric", serviceId: cutId }]);
    const token = created.body.manageToken as string;
    await request(app).post(`/api/book/group/${token}/cancel`).send({});
    const again = await request(app).post(`/api/book/group/${token}/cancel`).send({});
    expect(again.status).toBe(200);
    expect(again.body.canceled).toBe(0);
  });

  it("a cancelled group cannot be rescheduled", async () => {
    const created = await createGroup([{ firstName: "Eric", serviceId: cutId }]);
    const token = created.body.manageToken as string;
    await request(app).post(`/api/book/group/${token}/cancel`).send({});
    const moved = await request(app)
      .post(`/api/book/group/${token}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(moved.status).toBe(409);
  });
});

describe("the plan a customer confirms against", () => {
  it("shows the sequence and the total without booking anything", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}/group/plan`)
      .send({
        staffId,
        startsAt: TWO_PM.toISOString(),
        attendees: [
          { firstName: "Eric", serviceId: cutId },
          { firstName: "Brother", serviceId: kidsId },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.plan.totalDurationMin).toBe(50);
    expect(res.body.plan.totalPriceCents).toBe(6500);
    expect(res.body.plan.members.map((m: { firstName: string }) => m.firstName)).toEqual([
      "Eric",
      "Brother",
    ]);
    // 🔴 Nothing was written.
    expect(await calendar()).toHaveLength(0);
  });
});
