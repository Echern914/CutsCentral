import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * BOOKING QUESTIONS, END TO END: the mobile mechanic's case.
 *
 * He cannot start a job without a street address and the vehicle's year, make
 * and model - so the booking form has to ask, the answers have to reach him,
 * and a blank required answer has to stop the booking rather than produce a
 * job he cannot do. Everything below is one of those four claims.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

/** A future instant (UTC) at the given hour, `daysAhead` days from now. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function makeShop(label: string, industry?: string) {
  const email = `iq-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Q", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({
      name: label,
      bookingUrl: "https://q.test",
      smsAttested: true,
      ...(industry ? { industry } : {}),
    });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  return { cookie: c, shopId: shop.body.id as string };
}

beforeAll(async () => {
  // The vertical this feature exists for.
  const made = await makeShop("RNO Mobile Mechanic", "mechanic");
  cookie = made.cookie;
  shopId = made.shopId;

  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  slug = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug;

  staffId = (
    await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Rob" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Diagnostic", durationMin: 60, price: 120, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules });
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.bookingQuestion.deleteMany({ where: { shopId } });
});

const list = () => request(app).get("/api/booking/questions").set("Cookie", cookie);
const add = (body: unknown) =>
  request(app).post("/api/booking/questions").set("Cookie", cookie).send(body as object);

describe("the suggested questions for a business type", () => {
  it("seeds exactly what a mobile mechanic has to ask, and marks the right ones required", async () => {
    const res = await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(5);

    const questions = (await list()).body.questions as {
      label: string;
      kind: string;
      required: boolean;
      sortOrder: number;
    }[];
    expect(questions.map((q) => q.label)).toEqual([
      "Service address",
      "Vehicle year",
      "Make",
      "Model",
      "What's it doing?",
    ]);
    // He cannot drive to an address he was not given, or quote parts for a car
    // he cannot identify. The symptom field is a nicety, so it is optional.
    expect(questions.filter((q) => q.required).map((q) => q.label)).toEqual([
      "Service address",
      "Vehicle year",
      "Make",
      "Model",
    ]);
    expect(questions[0]!.kind).toBe("address");
  });

  it("🔴 seeding twice adds nothing - a second tap can't duplicate the form", async () => {
    await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    const again = await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    expect(again.body.added).toBe(0);
    expect((await list()).body.questions).toHaveLength(5);
  });

  it("brings back one the owner deleted by accident", async () => {
    await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    const first = (await list()).body.questions[0] as { id: string };
    await request(app)
      .delete(`/api/booking/questions/${first.id}`)
      .set("Cookie", cookie);
    const again = await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    expect(again.body.added).toBe(1);
  });

  it("appends after the shop's own questions instead of reordering them", async () => {
    await add({ label: "Gate code", kind: "text", sortOrder: 0 });
    await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    const labels = ((await list()).body.questions as { label: string }[]).map((q) => q.label);
    expect(labels[0]).toBe("Gate code");
  });

  it("a barbershop is offered one optional note, and nothing is required", async () => {
    const barber = await makeShop("Fades", "barber");
    const res = await request(app)
      .post("/api/booking/questions/seed")
      .set("Cookie", barber.cookie);
    expect(res.status).toBe(201);
    const questions = (
      await request(app).get("/api/booking/questions").set("Cookie", barber.cookie)
    ).body.questions as { label: string; required: boolean }[];
    expect(questions).toHaveLength(1);
    expect(questions[0]!.required).toBe(false);
  });
});

describe("editing the form", () => {
  it("creates, edits and removes a question", async () => {
    const created = await add({ label: "Gate code", kind: "text", helpText: "If you have one" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const patched = await request(app)
      .patch(`/api/booking/questions/${id}`)
      .set("Cookie", cookie)
      .send({ label: "Gate or buzzer code", required: true });
    expect(patched.status).toBe(200);
    let q = (await list()).body.questions[0] as { label: string; required: boolean };
    expect(q.label).toBe("Gate or buzzer code");
    expect(q.required).toBe(true);

    const del = await request(app)
      .delete(`/api/booking/questions/${id}`)
      .set("Cookie", cookie);
    expect(del.body.ok).toBe(true);
    expect((await list()).body.questions).toHaveLength(0);
  });

  it("refuses a multiple-choice question with nothing to choose", async () => {
    const res = await add({ label: "Transmission", kind: "select", options: ["  ", ""] });
    expect(res.status).toBe(400);
  });

  it("clears stale options when a select becomes a text field", async () => {
    const id = (await add({ label: "Transmission", kind: "select", options: ["Auto", "Manual"] }))
      .body.id as string;
    await request(app)
      .patch(`/api/booking/questions/${id}`)
      .set("Cookie", cookie)
      .send({ kind: "text" });
    const q = (await list()).body.questions[0] as { kind: string; options: string[] };
    expect(q.kind).toBe("text");
    expect(q.options).toEqual([]);
  });

  it("an empty PATCH is not mistaken for a missing question", async () => {
    const id = (await add({ label: "Gate code", kind: "text" })).body.id as string;
    const res = await request(app)
      .patch(`/api/booking/questions/${id}`)
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it("🔴 another shop's question is NOT FOUND, never editable", async () => {
    const other = await makeShop("Other Shop");
    const foreign = (
      await request(app)
        .post("/api/booking/questions")
        .set("Cookie", other.cookie)
        .send({ label: "Theirs", kind: "text" })
    ).body.id as string;

    const patched = await request(app)
      .patch(`/api/booking/questions/${foreign}`)
      .set("Cookie", cookie)
      .send({ label: "Mine now" });
    expect(patched.status).toBe(404);
    const deleted = await request(app)
      .delete(`/api/booking/questions/${foreign}`)
      .set("Cookie", cookie);
    expect(deleted.body.ok).toBe(false);
    // Still theirs, still untouched.
    const theirs = (
      await request(app).get("/api/booking/questions").set("Cookie", other.cookie)
    ).body.questions as { label: string }[];
    expect(theirs.map((q) => q.label)).toEqual(["Theirs"]);
  });

  it("an inactive question stays in the EDITOR but leaves the booking page", async () => {
    const id = (await add({ label: "Gate code", kind: "text" })).body.id as string;
    await request(app)
      .patch(`/api/booking/questions/${id}`)
      .set("Cookie", cookie)
      .send({ active: false });
    expect((await list()).body.questions).toHaveLength(1);
    const publicData = await request(app).get(`/api/book/${slug}`);
    expect(publicData.body.questions).toEqual([]);
  });
});

describe("scoping a question to the services that need it", () => {
  let mobileServiceId: string;
  let inShopServiceId: string;

  beforeEach(async () => {
    // Two jobs a mechanic really runs: one he drives to, one done in his bay.
    mobileServiceId = serviceId;
    inShopServiceId = (
      await request(app)
        .post("/api/booking/services")
        .set("Cookie", cookie)
        .send({ name: "In-shop repair", durationMin: 60, price: 150, staffIds: [staffId] })
    ).body.id;
  });

  async function addScoped(serviceIds: string[]) {
    const res = await request(app)
      .post("/api/booking/questions")
      .set("Cookie", cookie)
      .send({ label: "Service address", kind: "address", required: true, serviceIds });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("the public page carries the scope, so the form can add and drop the field", async () => {
    await addScoped([mobileServiceId]);
    const questions = (await request(app).get(`/api/book/${slug}`)).body.questions as {
      label: string;
      serviceIds: string[];
    }[];
    expect(questions[0]!.serviceIds).toEqual([mobileServiceId]);
  });

  it("🔴 a required question scoped elsewhere does NOT block this service's booking", async () => {
    // The whole point: the in-shop job must not demand an address, and must
    // not refuse a customer who was never shown the field.
    await addScoped([mobileServiceId]);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: inShopServiceId,
        startsAt: futureAtHour(2, 10).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
      });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId, serviceId: inShopServiceId },
      select: { intake: true },
    });
    expect(appt!.intake).toEqual([]);
  });

  it("and DOES block the service it was scoped to", async () => {
    const id = await addScoped([mobileServiceId]);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: mobileServiceId,
        startsAt: futureAtHour(2, 11).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
      });
    expect(res.status).toBe(422);
    expect(res.body.questionId).toBe(id);
  });

  it("an unscoped question is still asked on everything", async () => {
    await addScoped([]);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId: inShopServiceId,
        startsAt: futureAtHour(2, 12).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
      });
    expect(res.status).toBe(422);
  });

  it("🔴 drops a foreign service id rather than scoping to another shop's service", async () => {
    const other = await makeShop("Someone Else");
    const foreignService = (
      await request(app)
        .post("/api/booking/services")
        .set("Cookie", other.cookie)
        .send({ name: "Theirs", durationMin: 30, price: 20 })
    ).body.id as string;

    await request(app)
      .post("/api/booking/questions")
      .set("Cookie", cookie)
      .send({ label: "Scoped", kind: "text", serviceIds: [foreignService, mobileServiceId] });
    const q = (await list()).body.questions[0] as { serviceIds: string[] };
    // Only this shop's own service survives.
    expect(q.serviceIds).toEqual([mobileServiceId]);
  });
});

describe("the customer's booking", () => {
  async function seed() {
    await request(app).post("/api/booking/questions/seed").set("Cookie", cookie);
    const questions = (await request(app).get(`/api/book/${slug}`)).body.questions as {
      id: string;
      label: string;
    }[];
    const byLabel = new Map(questions.map((q) => [q.label, q.id]));
    return { questions, byLabel };
  }

  it("the public booking page is told what to ask", async () => {
    const { questions } = await seed();
    expect(questions.map((q) => q.label)).toEqual([
      "Service address",
      "Vehicle year",
      "Make",
      "Model",
      "What's it doing?",
    ]);
  });

  it("🔴 refuses the booking when a required answer is blank, naming the field", async () => {
    const { byLabel } = await seed();
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(1, 10).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
        intake: [{ questionId: byLabel.get("Vehicle year")!, value: "2014" }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INTAKE_INVALID");
    expect(res.body.questionId).toBe(byLabel.get("Service address"));
    expect(res.body.message).toBe("Service address is required.");
    // 🔴 Nothing was written: a refused booking must not hold a slot.
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });

  it("takes the booking with the answers, and freezes them onto it", async () => {
    const { byLabel } = await seed();
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(1, 11).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
        intake: [
          { questionId: byLabel.get("Service address")!, value: "12 Main St, Newark NJ 07102" },
          { questionId: byLabel.get("Vehicle year")!, value: "2014" },
          { questionId: byLabel.get("Make")!, value: "Honda" },
          { questionId: byLabel.get("Model")!, value: "Accord EX 2.4" },
          { questionId: byLabel.get("What's it doing?")!, value: "Grinding when I brake" },
        ],
      });
    expect(res.status).toBe(201);

    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { id: true, intake: true },
    });
    const answers = appt!.intake as unknown as { label: string; value: string }[];
    expect(answers.map((a) => `${a.label}: ${a.value}`)).toEqual([
      "Service address: 12 Main St, Newark NJ 07102",
      "Vehicle year: 2014",
      "Make: Honda",
      "Model: Accord EX 2.4",
      "What's it doing?: Grinding when I brake",
    ]);

    // And the mechanic can read them on the booking itself.
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.intake[0]).toEqual({
      label: "Service address",
      value: "12 Main St, Newark NJ 07102",
      kind: "address",
    });
  });

  it("🔴 renaming a question afterwards never rewrites what was answered", async () => {
    const { byLabel } = await seed();
    const addressId = byLabel.get("Service address")!;
    await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(1, 12).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
        intake: [
          { questionId: addressId, value: "12 Main St" },
          { questionId: byLabel.get("Vehicle year")!, value: "2014" },
          { questionId: byLabel.get("Make")!, value: "Honda" },
          { questionId: byLabel.get("Model")!, value: "Accord" },
        ],
      });
    // The owner renames it, then deletes it outright.
    await request(app)
      .patch(`/api/booking/questions/${addressId}`)
      .set("Cookie", cookie)
      .send({ label: "Where are you?" });
    await request(app).delete(`/api/booking/questions/${addressId}`).set("Cookie", cookie);

    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { id: true },
    });
    const detail = await request(app)
      .get(`/api/booking/appointments/${appt!.id}/detail`)
      .set("Cookie", cookie);
    // The job still says where it was booked for, under the name it was asked by.
    expect(detail.body.intake[0]).toEqual({
      label: "Service address",
      value: "12 Main St",
      kind: "address",
    });
  });

  it("a shop that asks nothing books exactly as it did before", async () => {
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(1, 13).toISOString(),
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
      });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId },
      select: { intake: true },
    });
    expect(appt!.intake).toEqual([]);
  });
});
