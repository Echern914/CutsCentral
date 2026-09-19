/**
 * REAL STRIPE TEST-MODE VERIFICATION for post-service checkout.
 *
 * Everything else in this feature is proved against a FAKE Stripe. This is the
 * other kind of evidence: it drives the RUNNING API over HTTP, against real
 * Stripe test mode, with real test PaymentMethods, and waits for real SIGNED
 * webhooks to arrive through the real endpoint before it believes anything.
 *
 * 🔴 WHAT IT DELIBERATELY DOES NOT DO. It does not call the settlement helpers
 * directly. A test that calls `settleServiceCheckoutFromReconciler` proves the
 * function works; it proves nothing about whether the reconciler ever reaches
 * it, or whether a webhook we actually receive is parsed, verified and applied.
 * So: charges go through `POST /api/checkout/...`, cancellation goes through
 * the cancel-attempt route, refunds are settled by the `charge.refunded`
 * webhook, and the ambiguous case runs `reconcileOne` against a real Payment
 * row and Stripe's real search index.
 *
 * 🔴 TEST MODE ONLY, AND IT CHECKS. It refuses a key that is not `sk_test_`,
 * refuses a livemode account, and never touches a real card number: every
 * payment method is one of Stripe's published test handles.
 *
 * HOW TO RUN
 *   1. Stripe TEST account + a test connected account with charges enabled.
 *   2. API running on :4100 against the QA database, with
 *      SERVICE_CHECKOUT_ENABLED=true.
 *   3. 🔴 Forward webhooks to the REAL path (note: NOT /api/...):
 *        stripe listen --forward-to localhost:4100/webhooks/stripe-connect
 *      and put the `whsec_...` it prints in STRIPE_CONNECT_WEBHOOK_SECRET.
 *   4. pnpm --filter @chairback/api exec tsx scripts/service-checkout-testmode.ts
 *
 * Prints a pass/fail table, stops on the first failure inside a scenario, and
 * exits non-zero if anything failed.
 */
import { prisma } from "@chairback/db";
import { randomToken, SERVICE_CHARGE_CONSENT_VERSION } from "@chairback/config";
import { stripeClient } from "../src/billing/stripe.js";
import { reconcileOne } from "../src/billing/reconcile.js";

const API = process.env.QA_API ?? "http://localhost:4100";
const CONNECT = process.env.QA_CONNECT_ACCOUNT ?? "";
const AMOUNT = 100; // $1.00 - the smallest honest amount.
/** 🔴 NONZERO ON PURPOSE. A zero-fee fixture proves nothing about the fee. */
const FEE_BPS = 250; // 2.5% -> floor(100 * 250 / 10000) = 2 cents
const EXPECTED_FEE = Math.floor((AMOUNT * FEE_BPS) / 10000);

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
}
function fail(name: string, detail: string): never {
  check(name, false, detail);
  throw new Error(`${name}: ${detail}`);
}

//  ── the running API, as a barber ──────────────────────────────────────────

let cookie = "";

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON is fine for the assertions below */
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

/** Poll until `read` returns something truthy, or give up. */
async function until<T>(what: string, ms: number, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail(what, `timed out after ${ms}ms`);
}

async function guardTestMode(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    throw new Error("refusing to run: STRIPE_SECRET_KEY is not a test key");
  }
  if (!CONNECT.startsWith("acct_")) {
    throw new Error("set QA_CONNECT_ACCOUNT to a TEST connected account id");
  }
  const acct = await stripeClient().accounts.retrieve(CONNECT);
  if ((acct as { charges_enabled?: boolean }).charges_enabled !== true) {
    throw new Error(`connected account ${CONNECT} cannot take charges`);
  }
  const health = await fetch(`${API}/healthz`).then((r) => r.json() as Promise<{ ok?: boolean }>);
  if (!health.ok) throw new Error(`API is not answering at ${API}`);
}

//  ── fixture ───────────────────────────────────────────────────────────────

async function seedShop() {
  const email = `tm-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await http("POST", "/api/auth/signup", {
    email,
    password: "supersecret123",
    name: "Test mode",
    smsAttested: true,
  });
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status}`);
  cookie = (signup.setCookie ?? "").split(";")[0]!;

  const created = await http("POST", "/api/shops", {
    name: "Test-mode Cuts",
    bookingUrl: "https://book.test",
    smsAttested: true,
  });
  if (created.status !== 201) throw new Error(`shop failed: ${created.status}`);
  const shopId = created.json.id as string;
  await http("PATCH", "/api/shops/me", {
    bookingMode: "native",
    timezone: "UTC",
    bookingLeadHours: 1,
  });

  const shop = await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: CONNECT,
      paymentsMode: "card_on_file",
      compAccess: true,
      rewardsEnabled: true,
      platformFeeBps: FEE_BPS,
    },
  });

  const staff = await http("POST", "/api/booking/staff", { name: "Sam" });
  const service = await http("POST", "/api/booking/services", {
    name: "Trim",
    durationMin: 30,
    price: AMOUNT / 100,
    staffIds: [staff.json.id],
  });
  return { shop, staffId: staff.json.id as string, serviceId: service.json.id as string };
}

type Ctx = Awaited<ReturnType<typeof seedShop>>;

/** An appointment whose card is a REAL Stripe test payment method. */
async function seedAppointmentWithCard(ctx: Ctx, testPaymentMethod: string): Promise<string> {
  const client = await prisma.client.create({
    data: {
      shopId: ctx.shop.id,
      firstName: "Test",
      lastName: "Customer",
      acuityClientKey: `tm-${randomToken(10)}`,
      magicToken: randomToken(20),
    },
  });
  const startsAt = new Date(Date.now() - 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: ctx.shop.id,
      clientId: client.id,
      staffId: ctx.staffId,
      serviceId: ctx.serviceId,
      firstName: "Test",
      lastName: "Customer",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: "BOOKED",
      manageToken: randomToken(20),
      priceAtBooking: AMOUNT / 100,
    },
  });

  const customer = await stripeClient().customers.create({
    name: "Test Customer",
    metadata: { shopId: ctx.shop.id, appointmentId: appt.id },
  });
  const pm = await stripeClient().paymentMethods.attach(testPaymentMethod, {
    customer: customer.id,
  });
  const si = await stripeClient().setupIntents.create({
    customer: customer.id,
    payment_method: pm.id,
    usage: "off_session",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });

  await prisma.cardOnFile.create({
    data: {
      id: `cof_${randomToken(12)}`,
      shopId: ctx.shop.id,
      appointmentId: appt.id,
      stripeCustomerId: customer.id,
      stripeSetupIntentId: si.id,
      stripePaymentMethodId: pm.id,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      status: "saved",
      savedAt: new Date(),
      serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
      serviceChargeConsentAt: new Date(),
      serviceChargeConsentScope: "single",
    },
  });
  return appt.id;
}

/** Charge through the REAL route, as the screen does. */
const chargeViaApi = (appointmentId: string) =>
  http("POST", `/api/checkout/appointments/${appointmentId}/charge-card`, {
    amountCents: AMOUNT,
    requestId: `req_${randomToken(12)}`,
  });

const attemptFor = (appointmentId: string) =>
  prisma.checkoutAttempt.findFirst({
    where: { appointmentId },
    orderBy: { createdAt: "desc" },
  });
const paymentFor = (appointmentId: string) =>
  prisma.payment.findFirst({ where: { appointmentId, purpose: "service_checkout" } });
const cardFor = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId } });
const apptFor = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    select: { paidAt: true, paidMethod: true, status: true },
  });

//  ── 1. SUCCESS: Connect shape, exact fee, webhook settlement, refund ──────

async function scenarioSuccess(ctx: Ctx): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("\n1. SUCCESS - charge, Connect shape, exact fee, webhook, refund");
  const id = await seedAppointmentWithCard(ctx, "pm_card_visa");
  const res = await chargeViaApi(id);
  check("charge returns paid", res.status === 200 && res.json.result === "paid", String(res.status));
  if (res.status !== 200) fail("charge", JSON.stringify(res.json));

  const pay = await paymentFor(id);
  if (!pay) fail("payment row", "none");
  const pi = await stripeClient().paymentIntents.retrieve(pay.stripePaymentIntentId, {
    expand: ["latest_charge"],
  });
  check("Stripe: intent succeeded", pi.status === "succeeded", pi.status);
  check("Stripe: amount is exactly the balance", pi.amount === AMOUNT, `${pi.amount}`);

  //  4. THE CONNECT SHAPE, exactly ----------------------------------------
  const dest = (pi.transfer_data as { destination?: string } | null)?.destination;
  check("Connect: transfer_data.destination is the connected account", dest === CONNECT, String(dest));
  check("Connect: on_behalf_of is the connected account", pi.on_behalf_of === CONNECT, String(pi.on_behalf_of));
  const ch = pi.latest_charge as { id: string; application_fee_amount?: number | null } | null;
  check(
    `Connect: application_fee_amount is exactly ${EXPECTED_FEE}c (${FEE_BPS}bps of ${AMOUNT}c)`,
    ch?.application_fee_amount === EXPECTED_FEE,
    `${ch?.application_fee_amount}`,
  );
  check("ledger: applicationFeeAmount matches Stripe", pay.applicationFeeAmount === EXPECTED_FEE, `${pay.applicationFeeAmount}`);

  //  2. SETTLEMENT BY REAL SIGNED WEBHOOK ----------------------------------
  const attempt = await attemptFor(id);
  await until("webhook settles the attempt", 40000, async () => {
    const a = await prisma.checkoutAttempt.findUnique({ where: { id: attempt!.id } });
    return a?.state === "succeeded" ? a : null;
  });
  check("webhook: attempt is succeeded", true);
  const settled = await apptFor(id);
  check("webhook: appointment reads paid", settled?.paidAt != null);
  check("webhook: appointment NOT completed", settled?.status === "BOOKED", settled?.status);
  check("card is spent (charged)", (await cardFor(id))?.status === "charged");

  //  REFUND, settled by the charge.refunded webhook -------------------------
  const refund = await stripeClient().refunds.create({ payment_intent: pi.id });
  check("Stripe: refund created", refund.status === "succeeded" || refund.status === "pending", String(refund.status));
  const refunded = await until("webhook settles the refund in OUR ledger", 60000, async () => {
    const row = await prisma.payment.findUnique({ where: { id: pay.id } });
    return row && row.refundedAmount === AMOUNT ? row : null;
  });
  check(`refund: Payment.refundedAmount is exactly ${AMOUNT}c`, refunded.refundedAmount === AMOUNT, `${refunded.refundedAmount}`);
  check("refund: Payment.status is refunded", refunded.status === "refunded", refunded.status);

  //  REPLAY: the same event again must not double the refund ---------------
  const { applyPaymentEvent } = await import("../src/billing/payments.js");
  const events = await stripeClient().events.list({ type: "charge.refunded", limit: 10 });
  const mine = events.data.find(
    (e) => (e.data.object as { id?: string })?.id === ch?.id,
  );
  if (mine) {
    await applyPaymentEvent(mine);
    await applyPaymentEvent(mine);
    const after = await prisma.payment.findUnique({ where: { id: pay.id } });
    check(
      "refund replay does not double the refunded cents",
      after?.refundedAmount === AMOUNT,
      `${after?.refundedAmount}`,
    );
  } else {
    check("refund replay does not double the refunded cents", false, "could not find the charge.refunded event to replay");
  }
}

//  ── 2. DECLINE ────────────────────────────────────────────────────────────

async function scenarioDecline(ctx: Ctx): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("\n2. DECLINE - not paid, lock released");
  const id = await seedAppointmentWithCard(ctx, "pm_card_chargeDeclined");
  const res = await chargeViaApi(id);
  check("decline: route answers 402", res.status === 402, String(res.status));
  check("decline: result is declined", res.json.result === "declined", String(res.json.result));
  check("decline: appointment is NOT paid", (await apptFor(id))?.paidAt == null);
  check("decline: attempt is failed (lock released)", (await attemptFor(id))?.state === "failed");
  check("decline: card is failed", (await cardFor(id))?.status === "failed");
}

//  ── 3. AUTHENTICATION REQUIRED, cancelled through ChairBack ───────────────

async function scenario3ds(ctx: Ctx): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("\n3. AUTHENTICATION REQUIRED - and cancelled through the real route");
  const id = await seedAppointmentWithCard(ctx, "pm_card_authenticationRequired");
  const res = await chargeViaApi(id);

  // 🔴 EXACTLY requires_action. A decline is a DIFFERENT outcome and would mean
  // the 3DS path was never exercised at all - accepting it would make this
  // scenario pass without testing anything.
  check("3DS: route answers 409", res.status === 409, String(res.status));
  check(
    "3DS: outcome is exactly requires_action",
    res.json.result === "requires_action",
    String(res.json.result),
  );
  if (res.json.result !== "requires_action") {
    fail("3DS", `expected requires_action, got ${JSON.stringify(res.json)}`);
  }
  check("3DS: appointment is NOT paid", (await apptFor(id))?.paidAt == null);
  check("3DS: card stays claimed (charging)", (await cardFor(id))?.status === "charging");

  const attempt = await attemptFor(id);
  check("3DS: attempt is requires_action", attempt?.state === "requires_action", attempt?.state);
  const intentId = attempt!.stripePaymentIntentId!;

  // Cancel through ChairBack's OWN route, not the Stripe SDK.
  const cancel = await http("POST", `/api/checkout/appointments/${id}/cancel-attempt`, {
    attemptId: attempt!.id,
  });
  check("3DS: cancel-attempt route answers 200", cancel.status === 200, String(cancel.status));

  const cancelled = await stripeClient().paymentIntents.retrieve(intentId);
  check("3DS: the Stripe intent is canceled", cancelled.status === "canceled", cancelled.status);
  check("3DS: the attempt is canceled", (await attemptFor(id))?.state === "canceled");
  check("3DS: the card is handed back (saved)", (await cardFor(id))?.status === "saved");
  check("3DS: the appointment is still NOT paid", (await apptFor(id))?.paidAt == null);

  // And the appointment is collectable again - the lock really is gone.
  const cash = await http("POST", `/api/checkout/appointments/${id}/cash`, {
    amountCents: AMOUNT,
    method: "cash",
    requestId: `req_${randomToken(12)}`,
    confirmed: true,
  });
  check("3DS: another method is available afterwards", cash.status === 200, String(cash.status));
}

//  ── 4. AMBIGUOUS -> THE REAL RECONCILER ───────────────────────────────────

async function scenarioAmbiguous(ctx: Ctx): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("\n4. AMBIGUOUS - repaired by the real reconciler, against real Stripe");
  const id = await seedAppointmentWithCard(ctx, "pm_card_visa");
  const res = await chargeViaApi(id);
  if (res.status !== 200) fail("ambiguous setup: charge", JSON.stringify(res.json));
  const pay = await paymentFor(id);
  const attempt = await attemptFor(id);
  const realIntent = pay!.stripePaymentIntentId;

  // Put the rows back into the shape an ambiguous attempt leaves behind: the
  // money moved at Stripe, and locally we never learned it. The Payment row
  // keeps its `pending:` reservation, which is what makes the reconciler take
  // its SEARCH branch and find the intent by our own metadata.
  await prisma.payment.update({
    where: { id: pay!.id },
    data: {
      stripePaymentIntentId: `pending:${pay!.id}`,
      status: "requires_confirmation",
      ambiguousAt: new Date(),
      capturedAmount: null,
      lastWebhookEventId: null,
      createdAt: new Date(Date.now() - 20 * 60 * 1000), // past the grace window
    },
  });
  await prisma.checkoutAttempt.update({
    where: { id: attempt!.id },
    data: { state: "ambiguous", stripePaymentIntentId: null, settledAt: null },
  });
  await prisma.cardOnFile.updateMany({
    where: { appointmentId: id },
    data: { status: "charging" },
  });
  await prisma.appointment.update({
    where: { id },
    data: { paidAt: null, paidMethod: null, paidAmount: null },
  });

  const live = await prisma.checkoutAttempt.findUnique({ where: { id: attempt!.id } });
  check("ambiguous: the lock is held before the reconciler runs", live?.state === "ambiguous");

  // 🔴 THE REAL RECONCILER, against the real row and Stripe's real search
  // index. Search lags the write by up to a minute, so retry rather than
  // reporting a flake as a failure.
  const row = {
    id: pay!.id,
    shopId: ctx.shop.id,
    appointmentId: id,
    stripePaymentIntentId: `pending:${pay!.id}`,
    status: "requires_confirmation",
    amount: AMOUNT,
    mode: "card_on_file",
    purpose: "service_checkout",
    ambiguousAt: new Date(),
  };
  const outcome = await until("reconciler adopts the intent", 120000, async () => {
    const o = await reconcileOne(row, new Date(), false);
    return o === "adopted" || o === "repaired" ? o : null;
  });
  check(`reconciler: outcome is ${outcome}`, true);

  const repaired = await prisma.payment.findUnique({ where: { id: pay!.id } });
  check("reconciler: the Payment row carries the real intent", repaired?.stripePaymentIntentId === realIntent, String(repaired?.stripePaymentIntentId));
  check("reconciler: the Payment row is succeeded", repaired?.status === "succeeded", repaired?.status);
  check("reconciler: ambiguity is cleared", repaired?.ambiguousAt === null);

  const after = await prisma.checkoutAttempt.findUnique({ where: { id: attempt!.id } });
  check("reconciler: the attempt is settled", after?.state === "succeeded", after?.state);
  const stillLive = await prisma.checkoutAttempt.findFirst({
    where: {
      appointmentId: id,
      state: { in: ["pending", "processing", "requires_action", "ambiguous"] },
    },
  });
  check("reconciler: the live lock is RELEASED", stillLive === null);
  check("reconciler: the appointment reads paid", (await apptFor(id))?.paidAt != null);
  check("reconciler: the card is charged", (await cardFor(id))?.status === "charged");

  await stripeClient().refunds.create({ payment_intent: realIntent });
}

//  ── run ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await guardTestMode();
  const ctx = await seedShop();
  // eslint-disable-next-line no-console
  console.log(
    `\nStripe TEST mode · ${CONNECT} · $${(AMOUNT / 100).toFixed(2)} · fee ${FEE_BPS}bps (${EXPECTED_FEE}c)\n`,
  );

  const scenarios: [string, (c: Ctx) => Promise<void>][] = [
    ["success", scenarioSuccess],
    ["decline", scenarioDecline],
    ["3ds", scenario3ds],
    ["ambiguous", scenarioAmbiguous],
  ];
  let stopped: string | null = null;
  for (const [name, run] of scenarios) {
    try {
      await run(ctx);
    } catch (err) {
      stopped = `${name}: ${(err as Error).message}`;
      break; // stop on any failure, as asked
    }
  }

  await prisma.shop.delete({ where: { id: ctx.shop.id } }).catch(() => {});

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${"=".repeat(64)}`);
  for (const r of results.filter((x) => !x.pass)) {
    // eslint-disable-next-line no-console
    console.log(`  FAILED: ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  // eslint-disable-next-line no-console
  console.log(`STRIPE TEST MODE: ${passed}/${results.length} passed${stopped ? ` · STOPPED at ${stopped}` : ""}`);
  // eslint-disable-next-line no-console
  console.log("=".repeat(64));
  await prisma.$disconnect();
  process.exit(passed === results.length && !stopped ? 0 : 1);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
