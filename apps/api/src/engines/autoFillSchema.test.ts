import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE AUTO-FILL TABLES' OWN RULES, asserted against the database itself.
 *
 * The engine leans on these: a run still going is always due at some time
 * (so the sweep can never lose it), a finished run always says how it
 * finished, one cancellation can only ever start one run, and an invitation
 * cannot claim it was delivered without having been sent. Each is a CHECK or
 * a unique index in the migration, so each is tested by trying to break it.
 */
const app = createApp();
const email = `autofill-schema-${randomToken(6)}@test.local`.toLowerCase();
let shopId = "";
let staffId = "";
let serviceId = "";
let appointmentId = "";
let openingId = "";
let accountId = "";
let clientId = "";

const startsAt = new Date(Date.now() + 5 * 24 * 3600_000);
const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

function run(over: Record<string, unknown> = {}) {
  return prisma.autoFillRun.create({
    data: {
      shopId,
      appointmentId,
      triggerKey: `cancel:${appointmentId}:r${randomToken(6)}`,
      staffId,
      serviceId,
      startsAt,
      endsAt,
      state: "queued",
      nextAt: new Date(),
      ...over,
    },
  });
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Schema", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Schema Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
  appointmentId = (
    await prisma.appointment.create({
      data: { shopId, staffId, serviceId, firstName: "Gone", status: "CANCELED", startsAt, endsAt, manageToken: randomToken() },
      select: { id: true },
    })
  ).id;
  openingId = (
    await prisma.tierOpening.create({
      data: { shopId, staffId, serviceId, startsAt, endsAt, minTier: "GOLD", heldUntil: startsAt },
      select: { id: true },
    })
  ).id;
  const phone = `+1629555${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `tel:${phone}`, magicToken: randomToken(), firstName: "M", phone, source: "manual" },
      select: { id: true },
    })
  ).id;
  accountId = (
    await prisma.customerAccount.create({
      data: { firstName: "M", phoneE164: phone, phoneVerifiedAt: new Date() },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (accountId) await prisma.customerAccount.deleteMany({ where: { id: accountId } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email } });
});

describe("AutoFillRun", () => {
  it("a run in progress and a finished run both write", async () => {
    await expect(run()).resolves.toBeTruthy();
    await expect(run({ state: "closed", nextAt: null, outcome: "claimed" })).resolves.toBeTruthy();
  });

  it("🔴 a run still going must be due at some time - the sweep could never find it otherwise", async () => {
    await expect(run({ nextAt: null })).rejects.toThrow(/AutoFillRun_due_check/);
    await expect(run({ state: "gold", nextAt: null })).rejects.toThrow(/AutoFillRun_due_check/);
  });

  it("🔴 a finished run is never due, and always says how it finished", async () => {
    await expect(run({ state: "closed", outcome: "claimed" })).rejects.toThrow(/AutoFillRun_due_check/);
    await expect(run({ state: "closed", nextAt: null })).rejects.toThrow(/AutoFillRun_outcome_check/);
    await expect(run({ outcome: "claimed" })).rejects.toThrow(/AutoFillRun_outcome_check/);
  });

  it("only the four states", async () => {
    await expect(run({ state: "bronze" })).rejects.toThrow(/AutoFillRun_state_check/);
  });

  it("🔴 one cancellation starts one run", async () => {
    const key = `cancel:${appointmentId}:r1`;
    await run({ triggerKey: key });
    await expect(run({ triggerKey: key })).rejects.toThrow(/Unique constraint/);
  });

  it("one run per opening", async () => {
    await run({ openingId });
    await expect(run({ openingId })).rejects.toThrow(/Unique constraint/);
  });
});

describe("TierOpening and its invitations", () => {
  it("an opening is manual or auto, nothing else", async () => {
    await expect(
      prisma.tierOpening.update({ where: { id: openingId }, data: { source: "robot" } }),
    ).rejects.toThrow(/TierOpening_source_check/);
  });

  it("🔴 an invitation cannot say it was delivered without having been sent", async () => {
    await expect(
      prisma.tierOpeningRecipient.create({ data: { openingId, accountId, clientId, delivered: true } }),
    ).rejects.toThrow(/TierOpeningRecipient_delivered_check/);
  });

  it("only the two waves", async () => {
    await expect(
      prisma.tierOpeningRecipient.create({ data: { openingId, accountId, clientId, wave: "bronze" } }),
    ).rejects.toThrow(/TierOpeningRecipient_wave_check/);
  });
});
