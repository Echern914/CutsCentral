import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import {
  cancellationIdempotencyKey,
  deliverCancellationIntent,
  MAX_ATTEMPTS,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
} from "./appointmentCanceledNotify.js";
import { RESEND_TIMEOUT_MS, ResendSendError } from "../messaging/email.js";
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
  // 🔴 ONE restoration point. Several cases install a throwing or suppressed
  // sender; restoring per-test meant one forgotten line silently starved every
  // later case of email and made real assertions pass for the wrong reason.
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em${emails.length}`, status: "sent" };
  });
  await prisma.emailDelivery.deleteMany({ where: { shopId } });
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
    // A rejected attempt is retried with BACKOFF, so the row is not due again
    // immediately - draining right away must correctly do nothing.
    await drain();
    expect(emails).toHaveLength(0);

    // Backoff after the first ambiguous attempt is 5 minutes.
    await drain(new Date(Date.now() + 6 * 60_000));
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
    expect(emails[0]!.idempotencyKey).toBe(cancellationIdempotencyKey(id, 1));
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
    // 🔴 The window runs from the FIRST REAL ATTEMPT, not from row creation.
    // One attempt now opens it...
    const first = new Date();
    await drain(first);
    let intent = (await intentsFor(id))[0]!;
    expect(intent.status).toBe("PENDING"); // still inside the window
    expect(intent.firstProviderAttemptAt).not.toBeNull();
    expect(intent.attempts).toBe(1);

    // ...and only an attempt past 24h from THAT moment is unsafe to repeat.
    const past = new Date(first.getTime() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000);
    await drain(past);
    intent = (await intentsFor(id))[0]!;
    expect(intent.status).toBe("ABANDONED");

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
    expect((await intentsFor(id))[0]!.status).toBe("SUPERSEDED");
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

describe("revision binding: an intent names an OCCURRENCE, not a request", () => {
  it("concurrent cancels with DIFFERENT clocks still produce one intent and one send", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    // 🔴 The real-world condition the old test hid by handing every racer the
    // same fixed NOON: concurrent requests have their own wall clocks.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        cancelAppointment(shopId, id, "CANCELED", new Date(NOON.getTime() + i * 137)),
      ),
    );
    const intents = await intentsFor(id);
    expect(intents).toHaveLength(1);
    // One occurrence, so exactly one revision bump.
    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.cancellationRevision).toBe(1);
    expect(intents[0]!.cancellationRevision).toBe(1);

    await drain();
    expect(emails).toHaveLength(1);
  });

  it("cancelling an ALREADY-canceled appointment creates nothing new", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const before = await prisma.appointment.findUnique({ where: { id } });

    // Repeated cancellation is an idempotent no-op: no second intent, no
    // second revision, no second email.
    await cancelAppointment(shopId, id, "CANCELED", new Date(NOON.getTime() + 5000));
    await cancelAppointment(shopId, id, "CANCELED", new Date(NOON.getTime() + 9000));

    expect(await intentsFor(id)).toHaveLength(1);
    const after = await prisma.appointment.findUnique({ where: { id } });
    expect(after!.cancellationRevision).toBe(before!.cancellationRevision);
    await drain();
    expect(emails).toHaveLength(1);
  });

  it("🔴 cancel A pending → restore → cancel B → the drain sends ONLY B", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    // A: canceled, intent queued, worker has NOT run yet.
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const [intentA] = await intentsFor(id);
    expect(intentA!.cancellationRevision).toBe(1);

    // Restore, exactly as /restore does - superseding the pending intent in
    // the same breath.
    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { id },
        data: { status: "BOOKED", canceledAt: null, cancellationEmailSentAt: null },
      });
      await tx.emailIntent.updateMany({
        where: { appointmentId: id, status: "PENDING" },
        data: { status: "SUPERSEDED", lastError: "restored" },
      });
    });

    // B: a genuinely new occurrence.
    await cancelAppointment(shopId, id, "CANCELED", new Date(NOON.getTime() + 1000));
    const intents = await intentsFor(id);
    expect(intents).toHaveLength(2);

    await drain(new Date(NOON.getTime() + 2000));
    // ONE email, and it is B's.
    expect(emails).toHaveLength(1);
    expect(emails[0]!.idempotencyKey).toBe(cancellationIdempotencyKey(id, 2));
  });

  it("the revision guard alone stops a stale intent, even if nothing superseded it", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    // Restore WITHOUT superseding - the belt fails, so the braces must hold.
    await prisma.appointment.update({
      where: { id },
      data: { status: "BOOKED", canceledAt: null, cancellationEmailSentAt: null },
    });
    await cancelAppointment(shopId, id, "CANCELED", new Date(NOON.getTime() + 1000));

    await drain(new Date(NOON.getTime() + 2000));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.idempotencyKey).toBe(cancellationIdempotencyKey(id, 2));
    const stale = (await intentsFor(id)).find((i) => i.cancellationRevision === 1);
    expect(stale!.status).toBe("SUPERSEDED");
  });

  it("restore then re-cancel in the SAME millisecond is still two occurrences", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    const t = new Date(NOON.getTime());
    await cancelAppointment(shopId, id, "CANCELED", t);
    await prisma.appointment.update({
      where: { id },
      data: { status: "BOOKED", canceledAt: null },
    });
    await cancelAppointment(shopId, id, "CANCELED", t); // identical timestamp
    const intents = await intentsFor(id);
    // A clock-keyed design would have collided here and silently sent nothing.
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((i) => i.idempotencyKey)).size).toBe(2);
  });
});

describe("provider attempt accounting", () => {
  it("five worker claims that die before dispatch consume ZERO provider attempts", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const [intent] = await intentsFor(id);

    // Model five crashed workers: each claims the row and dies. Only the claim
    // is on disk; no request was ever made.
    for (let i = 0; i < 5; i++) {
      await prisma.emailIntent.update({
        where: { id: intent!.id },
        data: { claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000) },
      });
      await prisma.emailIntent.update({
        where: { id: intent!.id },
        data: { claimedAt: null },
      });
    }
    const after = await prisma.emailIntent.findUnique({ where: { id: intent!.id } });
    expect(after!.attempts).toBe(0);
    expect(after!.firstProviderAttemptAt).toBeNull();

    // The budget is intact, so the message still goes.
    await drain();
    expect(emails).toHaveLength(1);
  });

  it("permits exactly MAX_ATTEMPTS real dispatches, then stops", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      throw new ResendSendError(500);
    });
    // Walk forward past each backoff so every due attempt is taken.
    let t = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      t += 2 * 60 * 60 * 1000;
      await drain(new Date(t));
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    const [intent] = await intentsFor(id);
    expect(intent!.status).toBe("FAILED"); // definitive rejection, not ambiguous
    expect(intent!.attempts).toBe(MAX_ATTEMPTS);
  });

  it("a DEFINITIVE rejection never ages into ABANDONED, and still retries past 24h", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      throw new ResendSendError(422); // Resend looked at it and said no
    });
    const first = new Date();
    await drain(first);
    expect((await intentsFor(id))[0]!.lastAttemptAmbiguous).toBe(false);

    // Well past the idempotency window: still not "maybe delivered", because
    // it was definitively refused - so the retry is safe and MUST still happen.
    // This is the case the pre-dispatch expiry guard must NOT catch.
    await drain(new Date(first.getTime() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000));
    expect(calls).toBe(2);
    const [intent] = await intentsFor(id);
    expect(intent!.status).not.toBe("ABANDONED");
    expect(intent!.status).toBe("PENDING");
  });

  it("enforces backoff between attempts, without sleeping", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      throw new ResendSendError(429);
    });
    await drain();
    expect(calls).toBe(1);
    await drain(); // immediately again - not due
    await drain();
    expect(calls).toBe(1);
    const [intent] = await intentsFor(id);
    expect(intent!.nextAttemptAt).not.toBeNull();
    // The first retry is 5 minutes out, so 2 minutes is deliberately too soon
    // and 6 is due.
    await drain(new Date(Date.now() + 2 * 60_000));
    expect(calls).toBe(1);
    await drain(new Date(Date.now() + 6 * 60_000));
    expect(calls).toBe(2);
  });
});

describe("suppression is terminal, not a queued blast", () => {
  it("DRY_RUN sends nothing, stamps nothing, and does not become SENT", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    // No injected sender => the real dispatch-mode logic applies, and the test
    // environment runs DRY_RUN=true.
    __setSendEmailForTests(undefined);
    await drain();

    const [intent] = await intentsFor(id);
    expect(intent!.status).toBe("SUPPRESSED");
    expect(intent!.attempts).toBe(0); // a dry run is not a provider attempt
    expect(intent!.firstProviderAttemptAt).toBeNull();
    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.cancellationEmailSentAt).toBeNull();

    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
  });

  it("🔴 enabling email later does NOT blast previously suppressed cancellations", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(undefined);
    await drain();
    expect((await intentsFor(id))[0]!.status).toBe("SUPPRESSED");

    // Email comes back on, weeks later. The old customer hears nothing - the
    // cancellation is long past and a surprise notice would be worse than
    // silence.
    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    await drain(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    expect(emails).toHaveLength(0);
  });

  it("an intent suppressed for over 24h is not mistaken for an expired ambiguous send", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(undefined);
    await drain(new Date(Date.now() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000));
    const [intent] = await intentsFor(id);
    // SUPPRESSED, not ABANDONED: nothing was ever put in front of the provider,
    // so there is no ambiguity to age out.
    expect(intent!.status).toBe("SUPPRESSED");
    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
  });
});

describe("confirmed acceptance", () => {
  it("a 2xx WITHOUT a message id does not stamp the appointment", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(async () => ({ id: "unknown", status: "sent" }));
    await drain();

    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.cancellationEmailSentAt).toBeNull();
    const [intent] = await intentsFor(id);
    expect(intent!.status).not.toBe("SENT");
    expect(intent!.attempts).toBe(1); // it WAS a real attempt

    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
  });

  it("settles the intent, the stamp AND the delivery row together", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    await drain();

    const [intent] = await intentsFor(id);
    expect(intent!.status).toBe("SENT");
    expect(intent!.messageId).toBeTruthy();
    const appt = await prisma.appointment.findUnique({ where: { id } });
    expect(appt!.cancellationEmailSentAt).not.toBeNull();
    // The ledger row exists synchronously, carrying the provider id - not left
    // to a fire-and-forget write that a crash could lose.
    const delivery = await prisma.emailDelivery.findUnique({
      where: { messageId: intent!.messageId! },
    });
    expect(delivery).not.toBeNull();
    expect(delivery!.kind).toBe("cancellation");
    expect(delivery!.appointmentId).toBe(id);
    await prisma.emailDelivery.deleteMany({ where: { appointmentId: id } });
  });
});

/**
 * 🔴 The window has to be checked BEFORE the request, not after it.
 *
 * Resend collapses repeats of an Idempotency-Key for 24 hours FROM THE FIRST
 * REQUEST. Past that the key is meaningless, so a fresh request is a fresh
 * email - and if the ambiguous first attempt had in fact been accepted, the
 * customer gets the same cancellation twice. Asking the question inside the
 * ambiguous handler asked it one HTTP call too late.
 */
describe("the expired-ambiguous guard runs BEFORE dispatch", () => {
  it("🔴 an expired ambiguous intent makes ZERO further provider calls and is ABANDONED", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);

    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      // Ambiguous, not definitive: the connection died, so this may already
      // have been accepted by Resend.
      throw new Error("socket hang up");
    });
    const first = new Date();
    await drain(first);
    expect(calls).toBe(1);
    let intent = (await intentsFor(id))[0]!;
    expect(intent.status).toBe("PENDING");
    expect(intent.lastAttemptAmbiguous).toBe(true);

    // A day later, with a sender that WOULD succeed. If the guard ran after
    // the request instead of before it, this is where the duplicate is sent.
    __setSendEmailForTests(async (input) => {
      calls++;
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    await drain(new Date(first.getTime() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000));

    expect(calls).toBe(1); // 🔴 the whole point - not one more request
    expect(emails).toHaveLength(0);
    intent = (await intentsFor(id))[0]!;
    expect(intent.status).toBe("ABANDONED");
    expect(intent.lastError).toBe("idempotency_window_expired");
    // A refusal to dispatch is not an attempt.
    expect(intent.attempts).toBe(1);
    expect((await prisma.appointment.findUnique({ where: { id } }))!
      .cancellationEmailSentAt).toBeNull();
  });

  it("an ambiguous retry INSIDE the window reuses the same key and may succeed", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    __setSendEmailForTests(async () => {
      throw new Error("socket hang up");
    });
    const first = new Date();
    await drain(first);

    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    // Six minutes later: past the backoff, nowhere near the 24h window, so the
    // provider still collapses a repeat of this key. Retrying is SAFE here and
    // the guard must not interfere.
    await drain(new Date(first.getTime() + 6 * 60_000));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.idempotencyKey).toBe(cancellationIdempotencyKey(id, 1));
    const [intent] = await intentsFor(id);
    expect(intent!.status).toBe("SENT");
    // Confirmed acceptance clears the marker - the next attempt, if there
    // somehow were one, is no longer working around an unknown.
    expect(intent!.lastAttemptAmbiguous).toBe(false);
  });

  it("an ambiguous attempt that runs out of budget is ABANDONED, never FAILED", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      throw new Error("socket hang up");
    });
    // Two hours per step keeps every pass INSIDE the 24h window, so this is
    // the budget running out rather than the window closing.
    let t = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      t += 2 * 60 * 60 * 1000;
      await drain(new Date(t));
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    const [intent] = await intentsFor(id);
    // We stopped WITHOUT KNOWING. Recording FAILED would claim the provider
    // refused it, which nothing here supports.
    expect(intent!.status).toBe("ABANDONED");
    expect(intent!.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe("ambiguity is WRITE-AHEAD, so a crash cannot look safe", () => {
  /** Poll a condition without sleeping a fixed guess. */
  async function until(cond: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it("🔴 a worker that dies AFTER the provider took the request still ABANDONS later", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);

    let calls = 0;
    let atRequestTime: {
      attempts: number;
      ambiguous: boolean;
      firstAt: Date | null;
      status: string;
    } | null = null;

    __setSendEmailForTests(async () => {
      calls++;
      // 🔴 THE TRANSACTION BOUNDARY, observed from a SEPARATE connection at the
      // exact moment the provider is being called. If the ambiguity write were
      // not already committed here, this read would say otherwise.
      const row = await prisma.emailIntent.findFirst({ where: { appointmentId: id } });
      atRequestTime = {
        attempts: row!.attempts,
        ambiguous: row!.lastAttemptAmbiguous,
        firstAt: row!.firstProviderAttemptAt,
        status: row!.status,
      };
      // Resend has the request and will accept it. Now the worker dies: this
      // promise NEVER settles, so every line after the await - the
      // classification, the settle, the ambiguity write - never runs. That is
      // exactly what a SIGKILL leaves behind, and it is the one crash that
      // cannot be recorded after the fact.
      return new Promise<never>(() => {});
    });

    const first = new Date();
    void drain(first); // deliberately NOT awaited - this worker never returns
    await until(() => calls === 1, "the provider request");
    await until(() => atRequestTime !== null, "the in-request read");

    // What was durable at the instant the request went out.
    expect(atRequestTime!.attempts).toBe(1);
    expect(atRequestTime!.firstAt).not.toBeNull();
    expect(atRequestTime!.ambiguous).toBe(true); // 🔴 WRITE-AHEAD
    expect(atRequestTime!.status).toBe("PENDING");

    // And what a restart finds on disk, the dead worker having written nothing
    // further: the ambiguity persisted automatically.
    const crashed = (await intentsFor(id))[0]!;
    expect(crashed.status).toBe("PENDING");
    expect(crashed.attempts).toBe(1);
    expect(crashed.lastAttemptAmbiguous).toBe(true);

    // A fresh worker, after the claim has aged out and the provider's key
    // window has closed. It would succeed if it tried - which is precisely why
    // it must not try.
    __setSendEmailForTests(async (input) => {
      calls++;
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    await drain(new Date(first.getTime() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000));

    const after = (await intentsFor(id))[0]!;
    expect(after.status).toBe("ABANDONED");
    expect(after.lastError).toBe("idempotency_window_expired");
    expect(calls).toBe(1); // 🔴 the provider was called EXACTLY ONCE, ever
    expect(emails).toHaveLength(0);
    expect(
      (await prisma.appointment.findUnique({ where: { id } }))!.cancellationEmailSentAt,
    ).toBeNull();
  });

  it("every retry in the safe window carries the SAME key, whatever the attempt, claim or clock", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);

    const keys: (string | undefined)[] = [];
    const claimTokens: (string | null)[] = [];
    __setSendEmailForTests(async (input) => {
      keys.push(input.idempotencyKey);
      throw new Error("socket hang up");
    });

    // Three attempts, half an hour apart, each under a FRESH claim token and a
    // different attempt number - all well inside the 24h window.
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      t += 30 * 60_000;
      await drain(new Date(t));
      claimTokens.push((await intentsFor(id))[0]!.claimToken);
    }

    expect(keys).toHaveLength(3);
    // The inputs that DID vary, so the constant below means something.
    expect(new Set(claimTokens).size).toBe(3);
    expect((await intentsFor(id))[0]!.attempts).toBe(3);

    // 🔴 One key, derived only from the durable intent identity and the
    // cancellation revision. If it moved with the attempt number, the claim or
    // the clock, the provider could not collapse the retries and every retry
    // would be a fresh email.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(cancellationIdempotencyKey(id, 1));
    expect((await intentsFor(id))[0]!.idempotencyKey).toBe(keys[0]);
  });

  it("the key is a pure function of appointment and revision", () => {
    // Same inputs, same key - twice, and across a revision bump.
    expect(cancellationIdempotencyKey("appt_1", 2)).toBe(
      cancellationIdempotencyKey("appt_1", 2),
    );
    expect(cancellationIdempotencyKey("appt_1", 2)).not.toBe(
      cancellationIdempotencyKey("appt_1", 3),
    );
  });
});

describe("attempt reservation is atomic and claim-bound", () => {
  it("🔴 a worker whose claim was replaced cannot spend another attempt", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const [intent] = await intentsFor(id);
    // The row is claimed - by somebody else, as far as our stale worker knows.
    await prisma.emailIntent.update({
      where: { id: intent!.id },
      data: { claimedAt: new Date(), claimToken: "claim-A" },
    });

    let calls = 0;
    __setSendEmailForTests(async (input) => {
      calls++;
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });

    // A worker that stalled past the TTL and had its row taken over: its token
    // is no longer the one on disk, so it must not dispatch at all.
    expect(
      await deliverCancellationIntent({
        intentId: intent!.id,
        claimToken: "claim-B",
        now: new Date(),
      }),
    ).toBe("stale_claim");
    expect(calls).toBe(0);
    expect((await intentsFor(id))[0]!.attempts).toBe(0);

    // The holder of the CURRENT claim proceeds normally.
    expect(
      await deliverCancellationIntent({
        intentId: intent!.id,
        claimToken: "claim-A",
        now: new Date(),
      }),
    ).toBe("sent");
    expect(calls).toBe(1);
  });

  it("concurrent workers lose no increment and cannot exceed MAX_ATTEMPTS", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    const [intent] = await intentsFor(id);
    await prisma.emailIntent.update({
      where: { id: intent!.id },
      data: { claimedAt: new Date(), claimToken: "claim-A" },
    });

    let calls = 0;
    __setSendEmailForTests(async () => {
      calls++;
      throw new ResendSendError(500);
    });

    // Eight racers on one claim. Deriving the attempt number from a value read
    // moments earlier would let two of them both write "3" - a lost increment,
    // and a provider call the budget never accounted for.
    const now = new Date();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        deliverCancellationIntent({ intentId: intent!.id, claimToken: "claim-A", now }),
      ),
    );

    expect(calls).toBe(MAX_ATTEMPTS);
    const [after] = await intentsFor(id);
    expect(after!.attempts).toBe(MAX_ATTEMPTS); // every dispatch got its own number
    expect(after!.status).toBe("FAILED"); // definitive rejections, so not ABANDONED
  });

  it("the provider request is bounded well inside the claim TTL", () => {
    // An unbounded fetch can outlive its own claim: the row becomes claimable,
    // a second worker takes it, and two requests for one message are in flight.
    expect(RESEND_TIMEOUT_MS).toBeLessThan(CLAIM_TTL_MS / 2);
  });
});
