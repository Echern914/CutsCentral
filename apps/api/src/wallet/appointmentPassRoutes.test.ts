import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * The Apple Wallet APPOINTMENT pass: web-service dispatch, manage-token
 * download routes, and the reschedule/cancel pokes.
 *
 * Like the punch-card suite, .pkpass SIGNING is not exercised (it needs a real
 * Apple certificate) - every route under test gates BEFORE signing. The two
 * pass types are BOTH configured here so the dispatch seam is real: a rewards
 * token must never open an appointment pass, and vice versa.
 *
 * Env is set before the app modules load (dynamic import): the wallet modules
 * freeze apiEnv() at module scope.
 */
const REWARDS_TYPE = "pass.test.chairback";
const APPT_TYPE = "pass.test.chairback.appointment";
process.env.WALLET_PASS_TYPE_ID = REWARDS_TYPE;
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_PASS_CERT_BASE64 = Buffer.from("test-cert").toString("base64");
process.env.WALLET_PASS_KEY_BASE64 = Buffer.from("test-key").toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("test-wwdr").toString("base64");
process.env.WALLET_APPT_PASS_TYPE_ID = APPT_TYPE;
process.env.WALLET_APPT_PASS_CERT_BASE64 = Buffer.from("test-appt-cert").toString("base64");
process.env.WALLET_APPT_PASS_KEY_BASE64 = Buffer.from("test-appt-key").toString("base64");

const { createApp } = await import("../app.js");
const { passAuthToken } = await import("./pass.js");
const { apptPassAuthToken, pokeAppointmentPass } = await import("./appointmentPass.js");
const { cancelAppointment } = await import("../engines/appointmentPromotion.js");

const app = createApp();
const DEVICE = `device-${randomToken(8)}`;
let userId: string;
let shopId: string;
let appointmentId: string;
let manageToken: string;

async function makeAppointment(
  opts: { status?: string; startsAt?: Date } = {},
): Promise<{ id: string; manageToken: string }> {
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Skin Fade", durationMin: 30 },
  });
  const startsAt = opts.startsAt ?? new Date(Date.now() + 3 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Casey",
      email: "casey@example.com",
      status: (opts.status ?? "BOOKED") as never,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { id: true, manageToken: true },
  });
  return appt;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wapt-${randomToken(6)}@test.local`, passwordHash: "x", name: "W" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Pass Cuts",
      slug: `wapt-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
      addressStreet: "1 Main St",
      addressCity: "Brooklyn",
      addressRegion: "NY",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const appt = await makeAppointment();
  appointmentId = appt.id;
  manageToken = appt.manageToken;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const apptAuth = () => `ApplePass ${apptPassAuthToken(appointmentId)}`;
const regUrl = (type: string, serial: string) =>
  `/api/wallet/v1/devices/${DEVICE}/registrations/${type}/${serial}`;

describe("web-service dispatch between the two pass types", () => {
  it("registers a device for an appointment pass (201, then 200 on repeat)", async () => {
    const first = await request(app)
      .post(regUrl(APPT_TYPE, appointmentId))
      .set("Authorization", apptAuth())
      .send({ pushToken: "tok-1" });
    expect(first.status).toBe(201);
    const again = await request(app)
      .post(regUrl(APPT_TYPE, appointmentId))
      .set("Authorization", apptAuth())
      .send({ pushToken: "tok-2" });
    expect(again.status).toBe(200);
    const rows = await prisma.walletAppointmentPassRegistration.findMany({
      where: { appointmentId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pushToken).toBe("tok-2"); // refreshed, not duplicated
    expect(rows[0]!.shopId).toBe(shopId);
  });

  it("🔴 a REWARDS token cannot act on an APPOINTMENT pass (domain separation)", async () => {
    // Same serial string, wrong HMAC domain: the punch-card token derivation
    // must never authenticate the appointment pass type.
    const res = await request(app)
      .post(regUrl(APPT_TYPE, appointmentId))
      .set("Authorization", `ApplePass ${passAuthToken(appointmentId)}`)
      .send({ pushToken: "t" });
    expect(res.status).toBe(401);
    // And the tokens genuinely differ for the same id string.
    expect(passAuthToken(appointmentId)).not.toBe(apptPassAuthToken(appointmentId));
  });

  it("404s a foreign pass type id without revealing which types exist", async () => {
    const res = await request(app)
      .post(regUrl("pass.someone.else", appointmentId))
      .set("Authorization", apptAuth())
      .send({ pushToken: "t" });
    expect(res.status).toBe(404);
  });

  it("404s a registration for an appointment that does not exist", async () => {
    const ghost = "clghost00000000000000000";
    const res = await request(app)
      .post(regUrl(APPT_TYPE, ghost))
      .set("Authorization", `ApplePass ${apptPassAuthToken(ghost)}`)
      .send({ pushToken: "t" });
    expect(res.status).toBe(404);
  });

  it("lists the device's APPOINTMENT serials, and filters by passesUpdatedSince", async () => {
    const list = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${APPT_TYPE}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.serialNumbers).toContain(appointmentId);

    // Nothing changed since the future: 204, exactly like the punch card.
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const quiet = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${APPT_TYPE}?passesUpdatedSince=${encodeURIComponent(later)}`,
    );
    expect(quiet.status).toBe(204);

    // Touch the appointment (a reschedule does this) - it reappears.
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { runningLate: false },
    });
    const after = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${APPT_TYPE}?passesUpdatedSince=${encodeURIComponent(later)}`,
    );
    // updatedAt moved past the tag only if the clock passed `later`; use a
    // past tag to assert the inclusion side deterministically instead.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const included = await request(app).get(
      `/api/wallet/v1/devices/${DEVICE}/registrations/${APPT_TYPE}?passesUpdatedSince=${encodeURIComponent(past)}`,
    );
    expect(included.status).toBe(200);
    expect(included.body.serialNumbers).toContain(appointmentId);
    expect([200, 204]).toContain(after.status);
  });

  it("the pass fetch refuses a bad token before any signing happens", async () => {
    const res = await request(app)
      .get(`/api/wallet/v1/passes/${APPT_TYPE}/${appointmentId}`)
      .set("Authorization", "ApplePass wrong");
    expect(res.status).toBe(401);
  });

  it("unregisters cleanly", async () => {
    const res = await request(app)
      .delete(regUrl(APPT_TYPE, appointmentId))
      .set("Authorization", apptAuth());
    expect(res.status).toBe(200);
    expect(
      await prisma.walletAppointmentPassRegistration.count({ where: { appointmentId } }),
    ).toBe(0);
  });

  it("rewards registrations still work, untouched by the second type", async () => {
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:${randomToken(8)}`,
        magicToken: randomToken(),
        firstName: "Cardholder",
      },
    });
    const res = await request(app)
      .post(regUrl(REWARDS_TYPE, client.id))
      .set("Authorization", `ApplePass ${passAuthToken(client.id)}`)
      .send({ pushToken: "rt" });
    expect(res.status).toBe(201);
    // And an APPOINTMENT token cannot act on the rewards type.
    const cross = await request(app)
      .post(regUrl(REWARDS_TYPE, client.id))
      .set("Authorization", `ApplePass ${apptPassAuthToken(client.id)}`)
      .send({ pushToken: "rt" });
    expect(cross.status).toBe(401);
  });
});

describe("the manage-token download routes", () => {
  it("serves the .ics with the right headers and content", async () => {
    const res = await request(app).get(`/api/book/manage/${manageToken}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.headers["content-disposition"]).toContain("appointment.ics");
    const body = res.text;
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("SUMMARY:Skin Fade at Pass Cuts");
    expect(body).toContain("LOCATION:1 Main St\\, Brooklyn\\, NY");
    // Long lines are FOLDED per RFC 5545, which can split a URL mid-token -
    // unfold before asserting, exactly as a calendar client parses it.
    expect(body.replace(/\r\n /g, "")).toContain(`/book/manage/${manageToken}`);
  });

  it("404s the .ics for an unknown token and for a canceled appointment", async () => {
    expect(
      (await request(app).get(`/api/book/manage/not-a-token/calendar.ics`)).status,
    ).toBe(404);
    const dead = await makeAppointment({ status: "CANCELED" });
    expect(
      (await request(app).get(`/api/book/manage/${dead.manageToken}/calendar.ics`))
        .status,
    ).toBe(404);
  });

  it("refuses a FRESH wallet download of anything not BOOKED", async () => {
    const dead = await makeAppointment({ status: "CANCELED" });
    expect(
      (await request(app).get(`/api/book/manage/${dead.manageToken}/wallet-pass`))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/book/manage/not-a-token/wallet-pass`)).status,
    ).toBe(404);
  });
});

describe("pokes on the appointment lifecycle", () => {
  it("poke with no registrations is nothing_to_do and never throws", async () => {
    const fresh = await makeAppointment();
    expect(await pokeAppointmentPass(fresh.id)).toBe("nothing_to_do");
  });

  it("🔴 DRY_RUN suppresses the push but the answer says RETRYABLE, not delivered", async () => {
    // Registrations exist, DRY_RUN=true in tests: the poke must refuse to
    // claim success - the pass on those devices is genuinely still stale.
    const fresh = await makeAppointment();
    await prisma.walletAppointmentPassRegistration.create({
      data: {
        shopId,
        appointmentId: fresh.id,
        deviceLibraryIdentifier: `d-${randomToken(6)}`,
        pushToken: "pt",
      },
    });
    expect(await pokeAppointmentPass(fresh.id)).toBe("retryable_unavailable");
  });

  it("cancelAppointment completes even though a poke would run (fire-and-forget)", async () => {
    const fresh = await makeAppointment();
    await prisma.walletAppointmentPassRegistration.create({
      data: {
        shopId,
        appointmentId: fresh.id,
        deviceLibraryIdentifier: `d-${randomToken(6)}`,
        pushToken: "pt",
      },
    });
    expect(await cancelAppointment(shopId, fresh.id, "CANCELED")).toBe(true);
    const after = await prisma.appointment.findUnique({ where: { id: fresh.id } });
    expect(after!.status).toBe("CANCELED");
  });

  it("registrations die with their appointment (FK cascade)", async () => {
    const fresh = await makeAppointment();
    await prisma.walletAppointmentPassRegistration.create({
      data: {
        shopId,
        appointmentId: fresh.id,
        deviceLibraryIdentifier: `d-${randomToken(6)}`,
        pushToken: "pt",
      },
    });
    await prisma.appointment.delete({ where: { id: fresh.id } });
    expect(
      await prisma.walletAppointmentPassRegistration.count({
        where: { appointmentId: fresh.id },
      }),
    ).toBe(0);
  });
});

describe("schema safety", () => {
  it("RLS is enabled + forced with the tenant policy on the new table", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ enabled: boolean; forced: boolean; policies: bigint }>
    >(`SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p
                WHERE p.tablename = 'WalletAppointmentPassRegistration') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'WalletAppointmentPassRegistration'`);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.forced).toBe(true);
    expect(Number(rows[0]!.policies)).toBe(1);
  });
});
