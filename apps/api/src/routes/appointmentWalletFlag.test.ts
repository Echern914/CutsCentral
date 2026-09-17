import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { forShop } from "@chairback/db";

/**
 * "ADD TO APPLE WALLET" FOR THE BOOKING — the flag the two screens read.
 *
 * The appointment pass has existed for a while (a download route, push updates
 * on reschedule, a button in the confirmation email) but it was invisible in the
 * product: the booking confirmation screen and the customer's home had no way to
 * know whether the pass could be minted, so neither offered it.
 *
 * Both now read a server-supplied flag, and that is the whole contract worth
 * pinning: a badge rendered on a shop where the pass type is unconfigured
 * downloads a 503, which is worse than no badge at all.
 *
 * 🔴 TWO GATES, DELIBERATELY INDEPENDENT. The punch card also requires the shop
 * to have rewards switched on; the appointment does not. A shop running no
 * loyalty programme still has customers who want the cut in their Wallet. This
 * suite proves the appointment flag does NOT inherit the rewards gate.
 *
 * The WALLET_APPT_* env is set before the app modules load (dynamic import
 * below): wallet/appointmentPass.ts freezes apiEnv() at module scope, so a
 * static import would have compiled it wallet-disabled and every assertion here
 * would pass for the wrong reason.
 */
process.env.WALLET_APPT_PASS_TYPE_ID = "pass.test.chairback.appt";
process.env.WALLET_APPT_PASS_CERT_BASE64 = Buffer.from("appt-cert").toString("base64");
process.env.WALLET_APPT_PASS_KEY_BASE64 = Buffer.from("appt-key").toString("base64");
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("test-wwdr").toString("base64");

const { createApp } = await import("../app.js");
const { appointmentWalletEnabled } = await import("../wallet/appointmentPass.js");

const app = createApp();
const email = `apptwallet-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
const magicToken = randomToken();

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Wallet Flag", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Pass Cuts", bookingUrl: "https://pass.test", smsAttested: true });
  expect(shop.status).toBe(201);

  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);

  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Pat" });
  expect(staff.status).toBe(201);

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staff.body.id] });
  expect(service.status).toBe(201);
});

describe("the booking page is told whether the appointment pass is real", () => {
  it("sanity: this suite runs with the pass type CONFIGURED", () => {
    // Without this the rest would pass against `false` and prove nothing.
    expect(appointmentWalletEnabled()).toBe(true);
  });

  it("GET /api/book/:slug carries walletPass.appointment", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.walletPass).toBeDefined();
    expect(res.body.walletPass.appointment).toBe(true);
  });
});

describe("the customer's home is told the same thing", () => {
  it("the rewards payload carries wallet.appointment, WITHOUT rewards being on", async () => {
    // Rewards are opt-IN for a new shop, so this shop has them OFF. The punch
    // card is therefore unavailable while the appointment pass is not — which
    // is the distinction the two flags exist to make.
    // forShop() is a hand-written facade, not the Prisma client: it has upsert,
    // not create (see the mcp-tools memo on what it does and does not expose).
    const key = `tel:+1555${randomToken(7)}`;
    await forShop(shopId).client.upsert({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
      create: { acuityClientKey: key, magicToken, firstName: "Ada" },
      update: {},
    });

    const res = await request(app).get(`/api/rewards/${magicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBeDefined();
    // 🔴 The point of the suite: appointment true, punch card false, same shop.
    expect(res.body.wallet.appointment).toBe(true);
    expect(res.body.wallet.available).toBe(false);
  });
});
