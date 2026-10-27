import request from "supertest";
import forge from "node-forge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";

/**
 * "Add to Apple Wallet" on My ChairBack's View details screen.
 *
 * Eric's ask: when a barber books a client by hand, the client can still put
 * that appointment in Apple Wallet from the app. The app's details screen had
 * no Wallet button at all, so a barber-made booking (which never went through
 * the booking page's confirmation step) had no way into Wallet from the app.
 *
 * What this suite pins, in the order a reviewer should check it:
 *   1. The detail payload says `canAddToWallet` for an upcoming BOOKED
 *      ChairBack booking - INCLUDING one the barber made through the
 *      dashboard's real New appointment route - and false for a request, a
 *      cancellation, a past visit and a synced visit.
 *   2. GET /api/me/appointments/:id/wallet-pass hands the OWNER the one URL
 *      that streams that booking's pass, and that URL really downloads a
 *      signed .pkpass (self-signed certs, as in appointmentPassSigning.test).
 *   3. Nobody else gets it: another customer, a signed-out caller, a guessed
 *      id, and the owner for a cancelled or past booking all get the same 404
 *      (401 signed out) - never a URL.
 *
 * Env is set BEFORE the app loads (dynamic import): wallet/appointmentPass.ts
 * freezes apiEnv() at module scope, so a static import would compile it
 * wallet-disabled and every "offered" assertion would fail for the wrong
 * reason - and every "refused" one would pass for the wrong reason.
 */

function selfSigned(commonName: string): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2040-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

// Vitest reuses a worker across files: remember what was there, put it back.
const WALLET_KEYS = [
  "WALLET_APPT_PASS_TYPE_ID",
  "WALLET_TEAM_ID",
  "WALLET_APPT_PASS_CERT_BASE64",
  "WALLET_APPT_PASS_KEY_BASE64",
  "WALLET_WWDR_CERT_BASE64",
  "CUSTOMER_ACCOUNTS_ENABLED",
] as const;
const before = Object.fromEntries(WALLET_KEYS.map((k) => [k, process.env[k]]));

const signer = selfSigned("Pass Type ID: pass.test.chairback.appointment");
const wwdr = selfSigned("Test WWDR");
process.env.WALLET_APPT_PASS_TYPE_ID = "pass.test.chairback.appointment";
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_APPT_PASS_CERT_BASE64 = Buffer.from(signer.certPem).toString("base64");
process.env.WALLET_APPT_PASS_KEY_BASE64 = Buffer.from(signer.keyPem).toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from(wwdr.certPem).toString("base64");
process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
__resetEnvCacheForTests();

const { createApp } = await import("../app.js");
const { mintCustomerSession } = await import("../auth/customerSession.js");
const { appointmentWalletEnabled } = await import("../wallet/appointmentPass.js");
const { apiEnv } = await import("@chairback/config");

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;
const ownerEmail = `cwallet-${randomToken(6)}@test.local`.toLowerCase();
const accountIds = new Set<string>();
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let slot = 0;

function randomPhone(): string {
  const exch = 200 + Math.floor(Math.random() * 700);
  const line = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1628${exch}${line}`;
}

async function account(phone: string) {
  const acct = await prisma.customerAccount.create({
    data: { phoneE164: phone, phoneVerifiedAt: new Date() },
  });
  accountIds.add(acct.id);
  return { id: acct.id, token: mintCustomerSession(acct.id, 0) };
}

/** A booking the barber makes through the dashboard's real New appointment route. */
async function barberBooks(phone: string, inDays: number): Promise<string> {
  slot += 1;
  const startsAt = new Date(Date.now() + inDays * DAY);
  startsAt.setUTCHours(10, slot * 2, 0, 0);
  const res = await request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, startsAt: startsAt.toISOString(), firstName: "Jordan", phone, customTime: true });
  expect(res.status).toBe(201);
  const appt = await prisma.appointment.findFirstOrThrow({
    where: { shopId, startsAt },
    select: { id: true, clientId: true },
  });
  expect(appt.clientId).toBeTruthy();
  return appt.id;
}

/** A row written directly, for states the dashboard cannot create on demand. */
async function row(clientId: string, status: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED", startsAt: Date) {
  slot += 1;
  const at = new Date(startsAt.getTime() + slot * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Jordan",
      status,
      startsAt: at,
      endsAt: new Date(at.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true, manageToken: true },
  });
}

const me = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  expect(appointmentWalletEnabled()).toBe(true);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password: "supersecret123", name: "Wallet Owner", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Wallet Cuts", bookingUrl: "https://wallet.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", bookingLeadMinutes: 0 },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Drick" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Skin fade", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
});

afterAll(async () => {
  if (accountIds.size > 0) await prisma.customerAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
  const user = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  for (const k of WALLET_KEYS) {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

describe("a booking the barber made by hand", () => {
  it("🔴 shows Add to Apple Wallet on View details, and the URL downloads a real pass", async () => {
    const phone = randomPhone();
    const apptId = await barberBooks(phone, 2);
    const cust = await account(phone);

    const detail = await me(`/api/me/appointments/a_${apptId}`, cust.token);
    expect(detail.status).toBe(200);
    expect(detail.body.appointment.status).toBe("booked");
    expect(detail.body.appointment.canAddToWallet).toBe(true);

    const res = await me(`/api/me/appointments/a_${apptId}/wallet-pass`, cust.token);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { manageToken } = await prisma.appointment.findUniqueOrThrow({
      where: { id: apptId },
      select: { manageToken: true },
    });
    // The SAME pass the confirmation email and the manage page link to: one
    // builder, one download route, on the web origin the app trusts.
    const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
    expect(res.body).toEqual({ url: `${base}/book/manage/${manageToken}/wallet-pass` });

    // And that route (behind the web relay) streams a signed .pkpass.
    const pass = await request(app)
      .get(`/api/book/manage/${manageToken}/wallet-pass`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pass.status).toBe(200);
    expect(pass.headers["content-type"]).toContain("application/vnd.apple.pkpass");
    // A .pkpass is a zip archive.
    expect((pass.body as Buffer).subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("the list rows stay lean - the flag is a detail-screen field", async () => {
    const phone = randomPhone();
    await barberBooks(phone, 3);
    const cust = await account(phone);
    const list = await me("/api/me/appointments", cust.token);
    expect(list.status).toBe(200);
    expect(list.body.upcoming).toHaveLength(1);
    expect(list.body.upcoming[0]).not.toHaveProperty("canAddToWallet");
  });
});

describe("🔴 only the customer whose booking it is", () => {
  it("another signed-in customer gets a 404, never the URL", async () => {
    const phone = randomPhone();
    const apptId = await barberBooks(phone, 4);
    const stranger = await account(randomPhone());
    const res = await me(`/api/me/appointments/a_${apptId}/wallet-pass`, stranger.token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(JSON.stringify(res.body)).not.toContain("/book/manage/");
  });

  it("a signed-out caller is refused", async () => {
    const phone = randomPhone();
    const apptId = await barberBooks(phone, 5);
    const res = await request(app).get(`/api/me/appointments/a_${apptId}/wallet-pass`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("/book/manage/");
  });

  it("a guessed or malformed id is a 404 identical to a stranger's", async () => {
    const cust = await account(randomPhone());
    for (const id of ["a_doesnotexist000", "v_whatever12345", "nonsense", "a_../../x"]) {
      const res = await me(`/api/me/appointments/${encodeURIComponent(id)}/wallet-pass`, cust.token);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
  });
});

describe("only a live, upcoming booking", () => {
  it("a cancelled, past, completed or requested booking is offered no pass", async () => {
    const phone = randomPhone();
    // The barber's booking creates (and keys) the client record they share.
    const liveId = await barberBooks(phone, 6);
    const { clientId } = await prisma.appointment.findUniqueOrThrow({
      where: { id: liveId },
      select: { clientId: true },
    });
    const cust = await account(phone);

    const canceled = await row(clientId!, "CANCELED", new Date(Date.now() + 2 * DAY));
    const past = await row(clientId!, "BOOKED", new Date(Date.now() - 2 * DAY));
    const completed = await row(clientId!, "COMPLETED", new Date(Date.now() - 3 * DAY));
    const requested = await row(clientId!, "PENDING", new Date(Date.now() + 3 * DAY));

    for (const a of [canceled, past, completed, requested]) {
      const detail = await me(`/api/me/appointments/a_${a.id}`, cust.token);
      expect(detail.status).toBe(200);
      expect(detail.body.appointment.canAddToWallet).toBe(false);
      const res = await me(`/api/me/appointments/a_${a.id}/wallet-pass`, cust.token);
      expect(res.status).toBe(404);
    }
    // ...while the live one beside them still is.
    const live = await me(`/api/me/appointments/a_${liveId}/wallet-pass`, cust.token);
    expect(live.status).toBe(200);
  });

  it("a synced/logged visit has no Appointment to mint from", async () => {
    const phone = randomPhone();
    const liveId = await barberBooks(phone, 7);
    const { clientId } = await prisma.appointment.findUniqueOrThrow({
      where: { id: liveId },
      select: { clientId: true },
    });
    const cust = await account(phone);
    const v = await prisma.visit.create({
      data: {
        shopId,
        clientId: clientId!,
        acuityAppointmentId: `${Math.floor(Math.random() * 1e9)}`,
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 8 * DAY),
      },
      select: { id: true },
    });
    const detail = await me(`/api/me/appointments/v_${v.id}`, cust.token);
    expect(detail.status).toBe(200);
    expect(detail.body.appointment.canAddToWallet).toBe(false);
    const res = await me(`/api/me/appointments/v_${v.id}/wallet-pass`, cust.token);
    expect(res.status).toBe(404);
  });
});
