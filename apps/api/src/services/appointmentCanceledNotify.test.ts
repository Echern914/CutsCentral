import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import {
  cancellationIdempotencyKey,
  deliverCancellationIntent,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
} from "./appointmentCanceledNotify.js";
import { runEmailOutbox, CLAIM_TTL_MS } from "../engines/emailOutbox.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";

/**
 * "Your appointment was canceled" - via a DURABLE OUTBOX.
 *
 * The contract is not "an email is sent" but: the promise to send survives a
 * crash at any point, exactly one message results however many times the
 * cancel is attempted or retried, and the cancellation itself is never undone
 * by a mail problem.
 *
 * Process death is modelled honestly: the intent row is the only thing that
 * survives a restart, so "kill the process here" is exercised by inspecting
 * the row and then running a FRESH worker pass against it.
 */

/** Drain the outbox the way the scheduled job does. */
const drain = (now?: Date) => runEmailOutbox(now ? { now } : {});

const intentsFor = (appointmentId: string) =>
  prisma.emailIntent.findMany({ where: { appointmentId } });

const NOON = new Date("2026-06-01T16:00:00Z");
let emails: SendEmailInput[] = [];
let userId: string;
let shopId: string;

async function makeAppointment(
  opts: {
    email?: string | null;
    status?: "BOOKED" | "CANCELED" | "NO_SHOW" | "COMPLETED";
    startsAt?: Date;
  } = {},
): Promise<string> {
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Skin Fade", durationMin: 30 },
  });
  const email = opts.email === undefined ? "casey@example.com" : opts.email;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Casey",
      email,
    },
  });
  const startsAt = opts.startsAt ?? new Date(NOON.getTime() + 3 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      clientId: client.id,
      firstName: "Casey",
      email,
      status: opts.status ?? "CANCELED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em${emails.length}`, status: "sent" };
  });
  const user = await prisma.user.create({
    data: { email: `cxl-${randomToken(6)}@test.local`, passwordHash: "x", name: "C" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Canceled Cuts",
      slug: `cxl-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
});

afterEach(async () => {
  emails = [];
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the cancellation email itself", () => {
  it("tells the customer what was canceled, and how to book again", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    expect(emails).toHaveLength(1);
    const e = emails[0]!;
    expect(e.subject).toContain("Canceled");
    expect(e.subject).toContain("Skin Fade");
    expect(e.html).toContain("Your appointment was canceled");
    expect(e.html).toContain("Sam");
    expect(e.html).toContain("Book another appointment");
    expect(e.fromName).toBe("Canceled Cuts");
    expect(e.stream).toBe("transactional");
  });

  it("offers NO manage/cancel button - it would resolve to nothing useful", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    const e = emails[0]!;
    expect(e.html).not.toContain("/book/manage/");
    expect(e.text).not.toContain("/book/manage/");
    expect(e.html).not.toContain("Reschedule or cancel");
  });

  it("puts no token or internal id in anything the CUSTOMER can see", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    const appt = await prisma.appointment.findUnique({ where: { id } });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    const e = emails[0]!;
    const visible = [e.subject, e.html ?? "", e.text].join("\n");
    expect(visible).not.toContain(appt!.manageToken);
    expect(visible).not.toContain(id);
    expect(visible).not.toContain(shopId);
  });

  it("has a text fallback that stands on its own", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    const t = emails[0]!.text;
    expect(t).toContain("Skin Fade");
    expect(t).toContain("Canceled Cuts");
    expect(t).toMatch(/canceled/i);
    expect(t).toContain("Book another appointment:");
    expect(t.length).toBeGreaterThan(60);
  });
});

describe("durability: the promise survives a crash", () => {
  it("leaves a PENDING intent committed with the cancellation, before any send", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);

    // This is exactly the "process died right after the cancel committed"
    // state: nothing sent, but the promise is on disk.
    const intents = await intentsFor(id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("PENDING");
    expect(emails).toHaveLength(0);

    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.status).toBe("CANCELED");
    expect(appt!.cancellationEmailSentAt).toBeNull();

    // A fresh worker - i.e. after the restart - keeps the promise.
    await drain();
    expect(emails).toHaveLength(1);
    const after = await prisma.appointment.findUnique({ where: { id } });
    expect(after!.cancellationEmailSentAt).not.toBeNull();
  });

  it("recovers an intent whose worker died AFTER claiming, before the request", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const [intent] = await intentsFor(id);

    // The claim is on disk and the holder is gone; nothing will release it.
    await prisma.emailIntent.update({
      where: { id: intent!.id },
      data: { claimedAt: new Date(), attempts: 1 },
    });
    // A worker running now must NOT steal a live claim.
    await drain();
    expect(emails).toHaveLength(0);

    // Once the claim ages out the row is fair game again.
    await drain(new Date(Date.now() + CLAIM_TTL_MS + 60_000));
    expect(emails).toHaveLength(1);
    expect((await intentsFor(id))[0]!.status).toBe("SENT");
  });

  it("stamps the appointment only AFTER the provider accepts", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(async () => {
      throw new Error("resend exploded");
    });
    await drain();
    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.cancellationEmailSentAt).toBeNull();
    expect(appt!.status).toBe("CANCELED"); // the cancel is never undone
    // Still PENDING: the old claim-then-send design suppressed this forever.
    expect((await intentsFor(id))[0]!.status).toBe("PENDING");

    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    await drain();
    expect(emails).toHaveLength(1);
    expect(
      (await prisma.appointment.findUnique({ where: { id } }))!.cancellationEmailSentAt,
    ).not.toBeNull();
  });
});

describe("exactly once", () => {
  it("creates ONE intent when cancellations race", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await Promise.all(
      Array.from({ length: 5 }, () => cancelAppointment(shopId, id, "CANCELED", NOON)),
    );
    expect(await intentsFor(id)).toHaveLength(1);
    await drain();
    expect(emails).toHaveLength(1);
  });

  it("sends a stable Idempotency-Key, so a provider retry cannot double up", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    expect(emails[0]!.idempotencyKey).toBe(cancellationIdempotencyKey(id, NOON));
  });

  it("a second and third drain after success do nothing", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    await drain();
    await drain();
    expect(emails).toHaveLength(1);
  });

  it("restore then cancel again produces a NEW email", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();
    expect(emails).toHaveLength(1);

    // Undo, exactly as /restore does.
    await prisma.appointment.update({
      where: { id },
      data: { status: "BOOKED", canceledAt: null, cancellationEmailSentAt: null },
    });

    // Canceled again at a DIFFERENT instant: a new occurrence, a new key.
    const later = new Date(NOON.getTime() + 60 * 60 * 1000);
    await cancelAppointment(shopId, id, "CANCELED", later);
    await drain(new Date(later.getTime() + 1000));
    expect(emails).toHaveLength(2);
    expect(new Set(emails.map((e) => e.idempotencyKey)).size).toBe(2);
    expect(await intentsFor(id)).toHaveLength(2);
  });
});

describe("giving up safely", () => {
  it("ABANDONS rather than blindly retrying past the provider idempotency window", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(async () => {
      throw new Error("ambiguous");
    });
    // Past 24h the key means nothing to Resend, so a retry could deliver a
    // SECOND copy. Terminal and visible beats a coin flip.
    const past = new Date(Date.now() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000);
    await drain(past);
    expect((await intentsFor(id))[0]!.status).toBe("ABANDONED");

    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    await drain(new Date(past.getTime() + 60_000));
    expect(emails).toHaveLength(0);
  });

  it("does not send for an appointment restored before the worker ran", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await prisma.appointment.update({
      where: { id },
      data: { status: "BOOKED", canceledAt: null },
    });
    await drain();
    expect(emails).toHaveLength(0);
    expect((await intentsFor(id))[0]!.status).toBe("FAILED");
  });

  it("records only a fixed classification, never provider prose", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(async () => {
      throw new Error("resend 422 to=casey@example.com key=re_live_SECRET body=<html>");
    });
    await drain();
    const flat = JSON.stringify((await intentsFor(id))[0]);
    expect(flat).not.toContain("casey@example.com");
    expect(flat).not.toContain("re_live_SECRET");
    expect(flat).not.toContain("<html>");
  });

  it("enqueues NOTHING for a NO_SHOW or for an appointment with no address", async () => {
    const noShow = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, noShow, "NO_SHOW", NOON);
    expect(await intentsFor(noShow)).toHaveLength(0);

    const noEmail = await makeAppointment({ status: "BOOKED", email: null });
    await cancelAppointment(shopId, noEmail, "CANCELED", NOON);
    expect(await intentsFor(noEmail)).toHaveLength(0);

    await drain();
    expect(emails).toHaveLength(0);
  });
});
