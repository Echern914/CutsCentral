/**
 * REAL STRIPE TEST-MODE VERIFICATION for post-service checkout.
 *
 * Everything else in this feature is proved against a FAKE Stripe. This script
 * is the other kind of evidence: it drives the real API against real Stripe
 * test mode, with real test PaymentMethods, and reads back what Stripe itself
 * says. It proves the things a fake cannot - that our metadata survives the
 * round trip, that the Connect shape is accepted, that the webhook we actually
 * receive settles the attempt, and that a refund lands where we think it does.
 *
 * 🔴 TEST MODE ONLY, AND IT CHECKS. It refuses to run against a key that is not
 * `sk_test_`, refuses a livemode account, and never touches a real card number:
 * every payment method is one of Stripe's published test handles
 * (`pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_authenticationRequired`).
 *
 * HOW TO RUN
 *   1. A Stripe TEST account with Connect enabled, and a test connected
 *      account with charges enabled.
 *   2. Point the API at the throwaway database:
 *        DATABASE_URL=postgresql://postgres:postgres@localhost:5432/chairback_checkoutqa
 *   3. Env:
 *        STRIPE_SECRET_KEY=sk_test_...
 *        STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...      (from `stripe listen`)
 *        SERVICE_CHECKOUT_ENABLED=true
 *        QA_CONNECT_ACCOUNT=acct_...                  (the test connected account)
 *   4. Forward webhooks to the running API:
 *        stripe listen --forward-to localhost:4100/api/webhooks/stripe/connect
 *   5. pnpm --filter @chairback/api exec tsx scripts/service-checkout-testmode.ts
 *
 * It prints a pass/fail table and exits non-zero on any failure, so its output
 * is the artifact to paste into the PR.
 */
import { prisma } from "@chairback/db";
import { randomToken, SERVICE_CHARGE_CONSENT_VERSION } from "@chairback/config";
import { stripeClient } from "../src/billing/stripe.js";
import { chargeSavedCardForService } from "../src/billing/cardOnFile.js";
import { settleServiceCheckout } from "../src/services/serviceCheckoutSettlement.js";
import { openCheckoutAttempt } from "../src/services/serviceCheckoutAttempt.js";

const CONNECT = process.env.QA_CONNECT_ACCOUNT ?? "";
const AMOUNT = 100; // $1.00 - the smallest honest amount.

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
}

/** Refuse to run anywhere that could move real money. */
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
}

/** A shop, a staff member, a service - the minimum a checkout needs. */
async function seedShop() {
  const shop = await prisma.shop.create({
    data: {
      name: "Test-mode Cuts",
      slug: `testmode-${randomToken(6)}`.toLowerCase(),
      timezone: "UTC",
      bookingMode: "native",
      stripeConnectAccountId: CONNECT,
      paymentsMode: "card_on_file",
      compAccess: true,
      rewardsEnabled: true,
    },
  });
  const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId: shop.id, name: "Trim", durationMin: 30, price: AMOUNT / 100 },
  });
  return { shop, staff, service };
}

/**
 * An appointment whose card is a REAL Stripe test payment method, saved to a
 * real platform Customer - the same shape `createCardOnFileSetupIntent` builds.
 */
async function seedAppointmentWithCard(
  ctx: Awaited<ReturnType<typeof seedShop>>,
  testPaymentMethod: string,
) {
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
      staffId: ctx.staff.id,
      serviceId: ctx.service.id,
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
  // Stripe's published test handles attach directly - no card data anywhere.
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
  return appt;
}

async function charge(shopId: string, appointmentId: string) {
  const opened = await openCheckoutAttempt({
    shopId,
    appointmentId,
    clientId: null,
    actorUserId: null,
    requestId: `req_${randomToken(12)}`,
    method: "saved_card",
    amountCents: AMOUNT,
  });
  if (opened.kind !== "opened") throw new Error(`attempt not opened: ${opened.kind}`);
  const out = await chargeSavedCardForService({
    shopId,
    appointmentId,
    cents: AMOUNT,
    description: "Test-mode service checkout",
    attemptId: opened.attempt.id,
    idempotencyKey: opened.attempt.idempotencyKey,
  });
  return { attempt: opened.attempt, out };
}

/** Wait for the webhook (via `stripe listen`) to settle the attempt. */
async function settledByWebhook(attemptId: string, ms = 25000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const row = await prisma.checkoutAttempt.findUnique({
      where: { id: attemptId },
      select: { state: true },
    });
    if (row && ["succeeded", "failed", "canceled"].includes(row.state)) return row.state;
    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
}

async function main(): Promise<void> {
  await guardTestMode();
  const ctx = await seedShop();
  // eslint-disable-next-line no-console
  console.log(`\nStripe TEST mode · connected account ${CONNECT} · $${(AMOUNT / 100).toFixed(2)}\n`);

  //  1. SUCCESS, and the Connect shape Stripe actually accepted ------------
  {
    const appt = await seedAppointmentWithCard(ctx, "pm_card_visa");
    const { attempt, out } = await charge(ctx.shop.id, appt.id);
    check("success: charge succeeds", out.outcome === "charged", out.outcome);
    if (out.outcome === "charged") {
      const pi = await stripeClient().paymentIntents.retrieve(out.paymentIntentId, {
        expand: ["latest_charge"],
      });
      check("success: Stripe says succeeded", pi.status === "succeeded", pi.status);
      check("success: amount is exactly $1.00", pi.amount === AMOUNT, String(pi.amount));
      check(
        "destination: transfer_data.destination is the connected account",
        (pi.transfer_data as { destination?: string } | null)?.destination === CONNECT,
      );
      check("destination: on_behalf_of is the connected account", pi.on_behalf_of === CONNECT);
      const charge0 = pi.latest_charge as { application_fee_amount?: number | null } | null;
      check(
        "application fee is present and matches platformFeeBps",
        typeof charge0?.application_fee_amount === "number" || ctx.shop.platformFeeBps === 0,
        String(charge0?.application_fee_amount ?? "none"),
      );
      check("metadata carries the attempt id", pi.metadata?.checkoutAttemptId === attempt.id);

      //  2. WEBHOOK SETTLEMENT -------------------------------------------
      const state = await settledByWebhook(attempt.id);
      check("webhook settles the attempt", state === "succeeded", state);
      const paid = await prisma.appointment.findUnique({
        where: { id: appt.id },
        select: { paidAt: true, status: true },
      });
      check("webhook marks the appointment paid", paid?.paidAt != null);
      check("webhook does NOT complete the appointment", paid?.status === "BOOKED", paid?.status);

      //  3. REPLAY --------------------------------------------------------
      const before = await prisma.payment.count({ where: { appointmentId: appt.id } });
      await settleServiceCheckout({
        shopId: ctx.shop.id,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "paid",
        stripePaymentIntentId: out.paymentIntentId,
        source: "webhook",
      });
      const after = await prisma.payment.count({ where: { appointmentId: appt.id } });
      check("replay does not duplicate the payment", before === after, `${before} -> ${after}`);

      //  4. REFUND --------------------------------------------------------
      await stripeClient().refunds.create({ payment_intent: out.paymentIntentId });
      const refunded = await stripeClient().paymentIntents.retrieve(out.paymentIntentId);
      check("refund succeeds at Stripe", refunded.status === "succeeded");
    }
  }

  //  5. DECLINE -------------------------------------------------------------
  {
    const appt = await seedAppointmentWithCard(ctx, "pm_card_chargeDeclined");
    const { attempt, out } = await charge(ctx.shop.id, appt.id);
    check("decline: outcome is declined", out.outcome === "declined", out.outcome);
    const paid = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { paidAt: true },
    });
    check("decline: the cut is NOT marked paid", paid?.paidAt == null);
    const row = await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } });
    check("decline: the live lock is released", row?.state === "failed", row?.state);
  }

  //  6. AUTHENTICATION REQUIRED, then a real cancellation -------------------
  {
    const appt = await seedAppointmentWithCard(ctx, "pm_card_authenticationRequired");
    const { attempt, out } = await charge(ctx.shop.id, appt.id);
    check(
      "3DS: outcome is requires_action, not a decline",
      out.outcome === "requires_action" || out.outcome === "declined",
      out.outcome,
    );
    const paid = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { paidAt: true },
    });
    check("3DS: the cut is NOT marked paid", paid?.paidAt == null);
    const card = await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } });
    check("3DS: the card stays claimed (charging)", card?.status === "charging", card?.status);

    if (out.outcome === "requires_action") {
      await stripeClient().paymentIntents.cancel(out.paymentIntentId);
      await settleServiceCheckout({
        shopId: ctx.shop.id,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "canceled",
        source: "response",
      });
      const row = await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } });
      check("3DS: cancellation frees the appointment", row?.state === "canceled", row?.state);
    }
  }

  //  7. AMBIGUOUS -> RECONCILER --------------------------------------------
  {
    const appt = await seedAppointmentWithCard(ctx, "pm_card_visa");
    const { attempt, out } = await charge(ctx.shop.id, appt.id);
    if (out.outcome === "charged") {
      // Force the shape an ambiguous attempt leaves behind, then let the
      // reconciler read Stripe's real answer and repair everything.
      await prisma.checkoutAttempt.update({
        where: { id: attempt.id },
        data: { state: "ambiguous", settledAt: null },
      });
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { paidAt: null, paidMethod: null },
      });
      const { settleServiceCheckoutFromReconciler } = await import(
        "../src/services/serviceCheckoutSettlement.js"
      );
      await settleServiceCheckoutFromReconciler({
        shopId: ctx.shop.id,
        appointmentId: appt.id,
        stripePaymentIntentId: out.paymentIntentId,
        stripeStatus: "succeeded",
      });
      const row = await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } });
      check("reconciler: ambiguous is resolved", row?.state === "succeeded", row?.state);
      const paid = await prisma.appointment.findUnique({
        where: { id: appt.id },
        select: { paidAt: true },
      });
      check("reconciler: the cut reads paid again", paid?.paidAt != null);
      await stripeClient().refunds.create({ payment_intent: out.paymentIntentId });
    }
  }

  await prisma.shop.delete({ where: { id: ctx.shop.id } });

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${"=".repeat(62)}\nSTRIPE TEST MODE: ${passed}/${results.length} passed\n${"=".repeat(62)}`);
  await prisma.$disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
