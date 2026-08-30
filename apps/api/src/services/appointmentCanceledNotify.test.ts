import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { notifyAppointmentCanceled } from "./appointmentCanceledNotify.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";

/**
 * "Your appointment was canceled" - the email a ChairBack customer never used
 * to receive on any path.
 *
 * The contract under test is not "an email is sent" but "EXACTLY ONE is sent,
 * from wherever the cancel came from, and never for something that is not a
 * cancellation".
 */

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

describe("the cancellation email", () => {
  it("tells the customer what was canceled, and how to book again", async () => {
    const id = await makeAppointment();
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("sent");
    expect(emails).toHaveLength(1);
    const e = emails[0]!;
    expect(e.subject).toContain("Canceled");
    expect(e.subject).toContain("Skin Fade");
    expect(e.html).toContain("Your appointment was canceled");
    expect(e.html).toContain("Skin Fade");
    expect(e.html).toContain("Sam"); // the barber they booked with
    expect(e.html).toContain("Book another appointment");
    // The shop leads the From line - the customer booked at a shop, not at us.
    expect(e.fromName).toBe("Canceled Cuts");
    expect(e.stream ?? "transactional").toBe("transactional");
  });

  it("offers NO manage/cancel button - it would resolve to nothing useful", async () => {
    const id = await makeAppointment();
    await notifyAppointmentCanceled({ shopId, appointmentId: id });
    const e = emails[0]!;
    expect(e.html).not.toContain("/book/manage/");
    expect(e.text).not.toContain("/book/manage/");
    expect(e.html).not.toContain("Reschedule or cancel");
  });

  it("puts no token or internal id in anything the CUSTOMER can see", async () => {
    const id = await makeAppointment();
    const appt = await prisma.appointment.findUnique({ where: { id } });
    await notifyAppointmentCanceled({ shopId, appointmentId: id });
    const e = emails[0]!;
    // The rendered message - subject, html, text - is what reaches a person.
    const visible = `${e.subject}
${e.html ?? ""}
${e.text}`;
    expect(visible).not.toContain(appt!.manageToken);
    expect(visible).not.toContain(id);
    expect(visible).not.toContain(shopId);
  });

  it("DOES carry shop/appointment ids as correlation metadata", async () => {
    // Deliberately the other half of the rule: ids belong in the observability
    // channel (which log line, which delivery event) and nowhere else. Without
    // them a bounce cannot be traced back to a booking.
    const id = await makeAppointment();
    await notifyAppointmentCanceled({ shopId, appointmentId: id });
    expect(emails[0]!.meta).toEqual({
      shopId,
      appointmentId: id,
      kind: "cancellation",
    });
  });

  it("has a text fallback that stands on its own", async () => {
    const id = await makeAppointment();
    await notifyAppointmentCanceled({ shopId, appointmentId: id });
    const t = emails[0]!.text;
    // Someone reading ONLY the plain part must learn what, where, when, and
    // what to do next.
    expect(t).toContain("Skin Fade");
    expect(t).toContain("Canceled Cuts");
    expect(t).toMatch(/canceled/i);
    expect(t).toContain("Book another appointment:");
    expect(t.length).toBeGreaterThan(60);
  });
});

describe("exactly once", () => {
  it("sends ONE email when two cancellations race", async () => {
    const id = await makeAppointment();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => notifyAppointmentCanceled({ shopId, appointmentId: id })),
    );
    expect(emails).toHaveLength(1);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "already_sent")).toHaveLength(5);
  });

  it("is idempotent on retry - a repeated call after success sends nothing", async () => {
    const id = await makeAppointment();
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("sent");
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("already_sent");
    expect(emails).toHaveLength(1);
  });

  it("does NOT re-send after an ambiguous provider failure", async () => {
    // The deliberate trade: the claim is taken BEFORE dispatch, so a provider
    // error that may or may not have delivered is never doubled up.
    const id = await makeAppointment();
    __setSendEmailForTests(async () => {
      throw new Error("resend_send_failed: 500 upstream exploded");
    });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("failed");
    __setSendEmailForTests(async (input) => {
      emails.push(input);
      return { id: `em${emails.length}`, status: "sent" };
    });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("already_sent");
    expect(emails).toHaveLength(0);
    const after = await prisma.appointment.findUnique({ where: { id } });
    // 🔴 And the CANCELLATION still stands - a mail failure never revives it.
    expect(after!.status).toBe("CANCELED");
    expect(after!.cancellationEmailSentAt).not.toBeNull();
  });

  it("leaks no address or provider text when the provider fails", async () => {
    const id = await makeAppointment();
    const { logger } = await import("../logger.js");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    __setSendEmailForTests(async () => {
      throw new Error("resend 422 to=casey@example.com key=re_live_SECRET");
    });
    try {
      await notifyAppointmentCanceled({ shopId, appointmentId: id });
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).not.toContain("casey@example.com");
      expect(logged).not.toContain("re_live_SECRET");
      expect(logged).toContain("cancellation_email_failed");
    } finally {
      errSpy.mockRestore();
      __setSendEmailForTests(async (input) => {
        emails.push(input);
        return { id: `em${emails.length}`, status: "sent" };
      });
    }
  });
});

describe("what must NOT trigger it", () => {
  it("sends nothing for a NO_SHOW", async () => {
    const id = await makeAppointment({ status: "NO_SHOW" });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("skipped");
    expect(emails).toHaveLength(0);
  });

  it("sends nothing for a COMPLETED appointment", async () => {
    const id = await makeAppointment({ status: "COMPLETED" });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("skipped");
    expect(emails).toHaveLength(0);
  });

  it("sends nothing for a still-BOOKED appointment (a stale call)", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("skipped");
    expect(emails).toHaveLength(0);
  });

  it("sends nothing when there is no address, and does not burn the claim", async () => {
    const id = await makeAppointment({ email: null });
    expect(await notifyAppointmentCanceled({ shopId, appointmentId: id })).toBe("skipped");
    expect(emails).toHaveLength(0);
    const after = await prisma.appointment.findUnique({ where: { id } });
    expect(after!.cancellationEmailSentAt).toBeNull();
  });
});

describe("the engine every cancel route funnels through", () => {
  it("emails the customer when cancelAppointment CANCELS", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "CANCELED", NOON);
    // cancelAppointment dispatches fire-and-forget after commit.
    await new Promise((r) => setTimeout(r, 400));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("Canceled");
    const after = await prisma.appointment.findUnique({ where: { id } });
    expect(after!.status).toBe("CANCELED");
  });

  it("emails NOTHING when cancelAppointment records a NO_SHOW", async () => {
    const id = await makeAppointment({ status: "BOOKED" });
    await cancelAppointment(shopId, id, "NO_SHOW", NOON);
    await new Promise((r) => setTimeout(r, 400));
    expect(emails).toHaveLength(0);
  });
});
