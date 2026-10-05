import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { suppressionAddressHash } from "./broadcastAudience.js";
import { deliveryFor } from "./emailOutbox.js";
import { runTipRequestSweep, TIP_ASK_DELAY_MS } from "./tipRequests.js";
import {
  deliverTipRequestIntent,
  TIP_REQUEST_KIND,
  tipAskBlockedReason,
  tipRequestKey,
} from "../services/tipEmails.js";

/**
 * "LEAVE A TIP": ONE email, about an hour after a visit the SHOP finished, at a
 * shop that takes tips online (Eric, 2026-10-05).
 *
 * The cases that matter are the ones that would embarrass the shop:
 *  - asking a client who never came (the 15-minute sweep completes an unmarked
 *    no-show, so only a visit the shop finished is asked);
 *  - asking twice, or asking after they already tipped;
 *  - asking someone who said "no more email", or is blocked or archived;
 *  - a link to a page with nothing to tip.
 */

// A fixed "now" per run on a random far-future day: the test DB persists
// between runs, and a constant NOW would let old rows wander into the window.
const NOW = new Date(Date.now() + (365 + Math.floor(Math.random() * 10_000)) * 24 * 3600_000);
const MIN = 60_000;

let userId = "";
let shopId = "";
let staffId = "";
let serviceId = "";
const ACCT = `acct_test_${randomToken(6)}`;
const sent: SendEmailInput[] = [];
const savedEnv = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_CONNECT_WEBHOOK_SECRET };

const TIP_READY = {
  onlineTipsEnabled: true,
  tipPolicy: "not_included",
  connectChargesEnabled: true,
  stripeConnectAccountId: ACCT,
  compAccess: true,
} as const;

async function setShop(data: Prisma.ShopUpdateInput) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

async function makeClient(over: Partial<{
  email: string | null;
  archivedAt: Date;
  bookingBlockedAt: Date;
  emailOptedOut: boolean;
  emailSuppressedAt: Date;
}> = {}): Promise<string> {
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tipask-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Jordan",
      email: over.email === undefined ? `jordan-${randomToken(6)}@test.local`.toLowerCase() : over.email,
      archivedAt: over.archivedAt ?? null,
      bookingBlockedAt: over.bookingBlockedAt ?? null,
      emailOptedOut: over.emailOptedOut ?? false,
      emailSuppressedAt: over.emailSuppressedAt ?? null,
    },
    select: { id: true },
  });
  return c.id;
}

let seq = 0;
/** A visit that ENDED `endedMinAgo` before NOW. Finished by the shop unless told otherwise. */
async function seedVisit(over: Partial<{
  endedMinAgo: number;
  status: "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
  clientId: string | null;
  apptEmail: string | null;
  completedByShop: boolean;
  paidAt: Date;
  checkInStatus: string;
  groupId: string;
  visitSourceId: string;
  bookedVia: string;
}> = {}): Promise<string> {
  seq += 1;
  const endsAt = new Date(NOW.getTime() - (over.endedMinAgo ?? 61) * MIN + seq * 1000);
  const clientId = over.clientId === undefined ? await makeClient() : over.clientId;
  let visitId: string | null = null;
  if (over.visitSourceId) {
    const v = await prisma.visit.create({
      data: {
        shopId,
        clientId: clientId ?? (await makeClient()),
        acuityAppointmentId: over.visitSourceId,
        status: "COMPLETED",
        scheduledAt: new Date(endsAt.getTime() - 30 * MIN),
        endAt: endsAt,
        serviceName: "Lineup",
      },
      select: { id: true },
    });
    visitId = v.id;
  }
  const a = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Jordan",
      email: over.apptEmail === undefined ? null : over.apptEmail,
      status: over.status ?? "COMPLETED",
      ...(over.status === "CANCELED" ? { canceledAt: NOW } : {}),
      startsAt: new Date(endsAt.getTime() - 30 * MIN),
      endsAt,
      manageToken: randomToken(20),
      priceAtBooking: new Prisma.Decimal("40.00"),
      completedByShop: over.completedByShop ?? true,
      paidAt: over.paidAt ?? null,
      checkInStatus: over.checkInStatus ?? null,
      groupId: over.groupId ?? null,
      visitId,
      bookedVia: over.bookedVia ?? null,
    },
    select: { id: true },
  });
  return a.id;
}

async function tipRow(appointmentId: string, status: string) {
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId,
      purpose: "tip",
      stripePaymentIntentId: `pi_ask_${randomToken(10)}`,
      stripeConnectAccountId: ACCT,
      mode: "ahead",
      amount: 800,
      status,
      ...(status === "succeeded" ? { capturedAmount: 800 } : {}),
    },
  });
}

const sweep = (opts: { take?: number } = {}) => runTipRequestSweep(NOW, { shopIds: [shopId], ...opts });
const stamp = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { tipRequestSentAt: true } }))
    .tipRequestSentAt;
const asks = (appointmentId: string) =>
  prisma.emailIntent.findMany({ where: { shopId, appointmentId, kind: TIP_REQUEST_KIND } });

async function deliverOwn(appointmentId: string, now: Date = NOW) {
  const [intent, ...more] = await asks(appointmentId);
  expect(more).toHaveLength(0);
  const claimToken = `test_${randomToken(12)}`;
  await prisma.emailIntent.update({
    where: { id: intent!.id },
    data: { claimToken, claimedAt: now, nextAttemptAt: null },
  });
  const outcome = await deliverTipRequestIntent({ intentId: intent!.id, claimToken, now });
  const row = await prisma.emailIntent.findUniqueOrThrow({ where: { id: intent!.id } });
  return { outcome, row };
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const user = await prisma.user.create({
    data: { email: `tipask-${randomToken(6)}@test.local`, passwordHash: "x", name: "T" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: userId, name: "Tip Ask Studio", webhookSecret: randomToken(), bookingMode: "native", ...TIP_READY },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Lineup", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
});

beforeEach(async () => {
  sent.length = 0;
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `em_${randomToken(8)}`, status: "sent" };
  });
  await setShop(TIP_READY);
  // Each test sees only its own visits: one left unasked by an earlier test
  // would otherwise sit in the window and take a slot of `take`.
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  // EmailIntent has no foreign key to its shop: a PENDING ask left behind
  // would be a due row in the shared outbox for every later suite.
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  process.env.STRIPE_SECRET_KEY = savedEnv.key;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = savedEnv.hook;
  if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY;
  if (savedEnv.hook === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
});

describe("who is asked", () => {
  it("🔴 a visit the shop finished an hour ago gets ONE ask, keyed to the visit", async () => {
    const id = await seedVisit();
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const rows = await asks(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(tipRequestKey(id));
    expect(rows[0]!.status).toBe("PENDING");
    expect(await stamp(id)).toEqual(NOW);

    await sweep();
    expect(await asks(id)).toHaveLength(1);
  });

  it("about an hour after, not sooner: a visit that ended 59 minutes ago waits", async () => {
    expect(TIP_ASK_DELAY_MS).toBe(60 * MIN);
    const id = await seedVisit({ endedMinAgo: 59 });
    await sweep();
    expect(await asks(id)).toHaveLength(0);
    expect(await stamp(id)).toBeNull();
  });

  it("finished by the shop means Done, a checkout, marked arrived, or a walk-in the shop started", async () => {
    const paid = await seedVisit({ completedByShop: false, paidAt: NOW });
    const arrived = await seedVisit({ completedByShop: false, checkInStatus: "arrived" });
    // A walk-in that ran past its estimate, so the 15-minute sweep completed
    // it before anyone pressed Complete: the shop still started it, so the
    // client was in the chair.
    const walkIn = await seedVisit({ completedByShop: false, bookedVia: "walk_in_queue" });
    await sweep();
    expect(await asks(paid)).toHaveLength(1);
    expect(await asks(arrived)).toHaveLength(1);
    expect(await asks(walkIn)).toHaveLength(1);
  });

  it("a tip they started and left (or whose card was declined) is no reason not to ask", async () => {
    // The tip card is still on offer for it, so the ask still points somewhere.
    const id = await seedVisit();
    await tipRow(id, "requires_payment_method");
    await sweep();
    expect(await asks(id)).toHaveLength(1);
    const { outcome } = await deliverOwn(id);
    expect(outcome).toBe("sent");
  });

  it("a shop with no tip policy saved yet IS asked (a NULL is not 'included')", async () => {
    await setShop({ tipPolicy: null });
    const id = await seedVisit();
    await sweep();
    expect(await asks(id)).toHaveLength(1);
  });

  it("the address on the booking is enough when the client record has none", async () => {
    const clientId = await makeClient({ email: null });
    const id = await seedVisit({ clientId, apptEmail: "typed@test.local" });
    await sweep();
    expect(await asks(id)).toHaveLength(1);
  });

  it("🔴 never asked, and never stamped, when any rule fails", async () => {
    const group = async () => {
      const g = await prisma.appointmentGroup.create({
        data: { shopId, staffId, firstName: "Jordan", manageToken: randomToken(20) },
        select: { id: true },
      });
      return seedVisit({ groupId: g.id });
    };
    const cases: Array<[string, () => Promise<string>, (() => Promise<void>)?]> = [
      // The sweep alone completed it: maybe someone who never came.
      ["only the 15-minute sweep completed it", () => seedVisit({ completedByShop: false })],
      ["still BOOKED", () => seedVisit({ status: "BOOKED" })],
      ["cancelled", () => seedVisit({ status: "CANCELED" })],
      ["no-show", () => seedVisit({ status: "NO_SHOW" })],
      ["a group booking", group],
      ["another platform's booking", () => seedVisit({ visitSourceId: `${Date.now()}${seq}` })],
      ["tips switched off", () => seedVisit(), () => setShop({ onlineTipsEnabled: false })],
      ["the price includes a tip", () => seedVisit(), () => setShop({ tipPolicy: "included" })],
      ["Stripe not ready", () => seedVisit(), () => setShop({ connectChargesEnabled: false })],
      ["no address anywhere", async () => seedVisit({ clientId: await makeClient({ email: null }) })],
      ["a malformed address", async () => seedVisit({ clientId: await makeClient({ email: "not-an-address" }) })],
      ["an archived client", async () => seedVisit({ clientId: await makeClient({ archivedAt: NOW }) })],
      ["a blocked client", async () => seedVisit({ clientId: await makeClient({ bookingBlockedAt: NOW }) })],
      ["a client who unsubscribed", async () => seedVisit({ clientId: await makeClient({ emailOptedOut: true }) })],
      ["a client whose email bounced", async () => seedVisit({ clientId: await makeClient({ emailSuppressedAt: NOW }) })],
      ["an address suppressed on its own", async () => {
        const to = `supp-${randomToken(6)}@test.local`.toLowerCase();
        await prisma.emailAddressSuppression.create({
          data: { shopId, addressHash: suppressionAddressHash(shopId, to)!, kind: "unsubscribe", source: "unsubscribe_link" },
        });
        return seedVisit({ clientId: await makeClient({ email: to }) });
      }],
      ["already tipped", async () => {
        const id = await seedVisit();
        await tipRow(id, "succeeded");
        return id;
      }],
      ["a tip under way", async () => {
        const id = await seedVisit();
        await tipRow(id, "processing");
        return id;
      }],
      ["ended more than 6 hours ago (the floor)", () => seedVisit({ endedMinAgo: 7 * 60 })],
    ];
    for (const [label, make, after] of cases) {
      await setShop(TIP_READY);
      const id = await make();
      if (after) await after();
      await sweep();
      expect(await asks(id), label).toHaveLength(0);
      expect(await stamp(id), label).toBeNull();
    }
  });

  it("a shop fixing the reason inside the window still gets the visit asked", async () => {
    await setShop({ onlineTipsEnabled: false });
    const id = await seedVisit();
    await sweep();
    expect(await asks(id)).toHaveLength(0);
    await setShop(TIP_READY);
    await sweep();
    expect(await asks(id)).toHaveLength(1);
  });

  it("🔴 email off (DRY_RUN or no provider): nobody asked, nobody stamped", async () => {
    const id = await seedVisit();
    __setSendEmailForTests(undefined);
    expect(await sweep()).toBe(0);
    expect(await asks(id)).toHaveLength(0);
    expect(await stamp(id)).toBeNull();
  });

  it("visits that can never be asked cannot crowd out one that can", async () => {
    // OLDER than the eligible one, so they come first in the sweep's order:
    // only the query's own filters keep them out of the first `take`.
    for (let i = 0; i < 4; i++) await seedVisit({ endedMinAgo: 120, completedByShop: false });
    for (let i = 0; i < 4; i++) await seedVisit({ endedMinAgo: 120, clientId: await makeClient({ email: null }) });
    for (let i = 0; i < 4; i++) {
      const tipped = await seedVisit({ endedMinAgo: 120 });
      await tipRow(tipped, "succeeded");
    }
    const eligible = await seedVisit({ endedMinAgo: 61 });
    await sweep({ take: 3 });
    expect(await asks(eligible)).toHaveLength(1);
  });

  it("🔴 two sweeps at once ask ONCE (the claim is the guard)", async () => {
    const id = await seedVisit();
    const { results, settledEarly } = await raceBehindRowLock<number>("Appointment", id, [sweep, sweep]);
    expect(settledEarly).toBe(0);
    const claims = winners(results);
    expect(claims).toHaveLength(2);
    expect(claims.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await asks(id)).toHaveLength(1);
  });
});

describe("the gate, on its own", () => {
  // The sweep's query filters these too; the gate is what delivery re-reads,
  // so each layer is pinned by itself.
  const facts = (over: {
    completedByShop?: boolean;
    paidAt?: Date | null;
    checkInStatus?: string | null;
    bookedVia?: string | null;
  }) => ({
    appt: {
      status: "COMPLETED",
      endsAt: new Date(NOW.getTime() - 61 * MIN),
      clientId: "c1",
      groupId: null,
      priceAtBooking: 40,
      visit: null,
      completedByShop: over.completedByShop ?? false,
      paidAt: over.paidAt ?? null,
      checkInStatus: over.checkInStatus ?? null,
      bookedVia: over.bookedVia ?? null,
      email: "a@test.local",
    },
    shop: { ...TIP_READY, subscriptionStatus: "active", trialEndsAt: null },
    tip: null,
    client: { email: null, archivedAt: null, bookingBlockedAt: null, emailOptedOut: false, emailSuppressedAt: null },
    addressSuppressed: false,
  });

  it("🔴 a visit only the sweep completed is 'not_by_shop'; any sign the shop finished it opens the gate", () => {
    expect(tipAskBlockedReason(facts({}), NOW)).toBe("not_by_shop");
    expect(tipAskBlockedReason(facts({ completedByShop: true }), NOW)).toBeNull();
    expect(tipAskBlockedReason(facts({ paidAt: NOW }), NOW)).toBeNull();
    expect(tipAskBlockedReason(facts({ checkInStatus: "arrived" }), NOW)).toBeNull();
    expect(tipAskBlockedReason(facts({ checkInStatus: "en_route" }), NOW)).toBe("not_by_shop");
    expect(tipAskBlockedReason(facts({ bookedVia: "walk_in_queue" }), NOW)).toBeNull();
    expect(tipAskBlockedReason(facts({ bookedVia: "online" }), NOW)).toBe("not_by_shop");
  });
});

describe("the email", () => {
  it("🔴 opens their own appointment page at the tip card, and says it is optional", async () => {
    const id = await seedVisit();
    await sweep();
    const { outcome, row } = await deliverOwn(id);
    expect(outcome).toBe("sent");
    expect(row.status).toBe("SENT");
    expect(sent).toHaveLength(1);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: appt.clientId! } });
    const mail = sent[0]!;
    expect(mail.to).toBe(client.email);
    expect(mail.subject).toBe("Thanks for visiting Tip Ask Studio");
    expect(mail.fromName).toBe("Tip Ask Studio");
    expect(mail.stream).toBe("transactional");
    expect(mail.idempotencyKey).toBe(tipRequestKey(id));
    for (const body of [mail.text, mail.html!]) {
      expect(body).toContain(`/book/manage/${appt.manageToken}?tip=1`);
      expect(body).toMatch(/optional/i);
    }
    expect(mail.html).toContain("Leave a tip");
    // Not the appointment shell's verbs, nothing that invites a reply, no
    // em dash, and none of the trade words the copy rules ban.
    for (const body of [mail.subject, mail.text, mail.html!]) {
      expect(body).not.toMatch(/Reschedule|reply|—|\b(barbers?|cuts?|haircuts?|chairs?)\b/i);
    }
  });

  it("🔴 a bounce on the ask suppresses the client - even one that reached us before our own write", async () => {
    const id = await seedVisit();
    await sweep();
    const messageId = `em_bounced_${randomToken(8)}`;
    // The provider's bounce webhook beat us: the row exists, bounced, with nobody on it.
    await prisma.emailDelivery.create({
      data: { messageId, kind: "unknown", status: "bounced", awaitingDispatchMeta: true },
    });
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: messageId, status: "sent" };
    });
    try {
      const { outcome } = await deliverOwn(id);
      expect(outcome).toBe("sent");
      const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
      const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { messageId } });
      expect(row.clientId).toBe(appt.clientId);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: appt.clientId! } });
      expect(client.emailSuppressedAt).not.toBeNull();
    } finally {
      await prisma.emailDelivery.deleteMany({ where: { messageId } });
    }
  });

  it("the address typed on the booking wins over the record's", async () => {
    const id = await seedVisit({ apptEmail: "typed-first@test.local" });
    await sweep();
    await deliverOwn(id);
    expect(sent[0]!.to).toBe("typed-first@test.local");
  });

  it("🔴 what changed since it was queued wins: nothing is sent", async () => {
    const cases: Array<[string, (id: string) => Promise<void>, string]> = [
      ["they tipped in between", (id) => tipRow(id, "succeeded"), "closed"],
      ["the visit was cancelled after it completed", async (id) => {
        await prisma.appointment.update({ where: { id }, data: { status: "CANCELED", canceledAt: NOW } });
      }, "closed"],
      ["tips were switched off", () => setShop({ onlineTipsEnabled: false }), "closed"],
      ["they unsubscribed", async (id) => {
        const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
        await prisma.client.update({ where: { id: appt.clientId! }, data: { emailOptedOut: true } });
      }, "opted_out"],
      ["they were blocked", async (id) => {
        const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
        await prisma.client.update({ where: { id: appt.clientId! }, data: { bookingBlockedAt: NOW } });
      }, "blocked"],
    ];
    for (const [label, change, reason] of cases) {
      await setShop(TIP_READY);
      sent.length = 0;
      const id = await seedVisit();
      await sweep();
      await change(id);
      const { outcome, row } = await deliverOwn(id);
      expect(outcome, label).toBe("superseded");
      expect(row.status, label).toBe("SUPERSEDED");
      expect(row.lastError, label).toBe(reason);
      expect(sent, label).toHaveLength(0);
    }
  });

  it("the tip window closing before it goes out cancels it", async () => {
    const id = await seedVisit();
    await sweep();
    const { outcome } = await deliverOwn(id, new Date(NOW.getTime() + 8 * 24 * 3600_000));
    expect(outcome).toBe("superseded");
    expect(sent).toHaveLength(0);
  });

  it("no address left at send time is FAILED in the ledger, before any dispatch-mode check", async () => {
    const id = await seedVisit();
    await sweep();
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    await prisma.client.update({ where: { id: appt.clientId! }, data: { email: null } });
    __setSendEmailForTests(undefined); // email off too: the address is still decided first
    const { outcome, row } = await deliverOwn(id);
    expect(outcome).toBe("skipped");
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe("no_address");
  });

  it("a claim it does not hold sends nothing", async () => {
    const id = await seedVisit();
    await sweep();
    const [intent] = await asks(id);
    expect(await deliverTipRequestIntent({ intentId: intent!.id, claimToken: "not-the-holder", now: NOW })).toBe(
      "stale_claim",
    );
    expect(sent).toHaveLength(0);
  });
});

describe("one outbox", () => {
  it("🔴 the worker routes the tip kinds to their own deliverers", async () => {
    const { deliverTipReceiptIntent } = await import("../services/tipEmails.js");
    expect(deliveryFor("tip_request")).toBe(deliverTipRequestIntent);
    expect(deliveryFor("tip_receipt")).toBe(deliverTipReceiptIntent);
  });

  it("🔴 every kind the database accepts has a deliverer - none falls through", async () => {
    // An unrouted kind used to land on the cancellation deliverer and settle
    // SUPERSEDED without a trace. Reading the live CHECK means a migration
    // that adds a kind without wiring it fails here, not silently in prod.
    const [row] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'EmailIntent_kind_check'`;
    const kinds = [...row!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(kinds).toEqual(expect.arrayContaining(["appointment_canceled", "tip_request", "tip_receipt"]));
    for (const kind of kinds) expect(deliveryFor(kind), kind).not.toBeNull();
  });

  it("a kind nothing delivers gets no deliverer (the worker then FAILS it, loudly)", () => {
    expect(deliveryFor("not_a_real_kind")).toBeNull();
  });
});
