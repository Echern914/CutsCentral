import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { ingestAppointment } from "../ingest.js";
import { runSyncedVisitReminders } from "../engines/syncedVisitReminders.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import type { AcuityAppointment } from "./types.js";

/**
 * THE PROVIDER'S OWN MANAGE PAGE, CAPTURED ON SYNC.
 *
 * A synced booking lives in the shop's Acuity calendar, so ChairBack has no
 * manage token for it and its reminder could only ever say "contact the shop".
 * Acuity does return a per-appointment `confirmationPage`, so a real button is
 * possible - but only where the shop permits client changes.
 *
 * 🔴 THE URL AND THE PERMISSION ARE DIFFERENT FACTS, and this is the file that
 * keeps them apart. Verified against a live connected account on 2026-09-13:
 * every upcoming appointment carried a confirmationPage while
 * `canClientReschedule` and `canClientCancel` were false on all of them,
 * because that shop has client changes switched off in Acuity. Storing the URL
 * as if it were permission would have shipped a button onto a page offering
 * nothing.
 *
 * Refreshed on EVERY pass, which is also how existing bookings are backfilled:
 * the half-hourly acuity-resync re-ingests a 365-day window, so no data
 * migration is needed and a shop that changes the setting is followed within
 * the half hour - in both directions.
 */

let shopId: string;
let ownerId: string;

const CONFIRMATION =
  "https://app.acuityscheduling.com/schedule.php?owner=27210928&id[]=deadbeefdeadbeefdeadbeefdeadbeef&action=appt";

function appt(over: Partial<AcuityAppointment> = {}): AcuityAppointment {
  return {
    id: `acu_${randomToken(6)}`,
    firstName: "Casey",
    lastName: "Jones",
    email: `c${randomToken(5)}@example.com`,
    phone: "+15551230000",
    datetime: new Date(Date.now() + 3 * 86400_000).toISOString(),
    type: "Skin Fade",
    ...over,
  } as AcuityAppointment;
}

const shopRow = () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

const visitFor = (acuityAppointmentId: string) =>
  prisma.visit.findFirstOrThrow({
    where: { shopId, acuityAppointmentId },
    select: {
      customerManageUrl: true,
      customerCanReschedule: true,
      customerCanCancel: true,
    },
  });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `acu-${randomToken(6)}@test.local`, passwordHash: "x", name: "A" },
    select: { id: true },
  });
  ownerId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Manage Link Cuts",
      ownerId,
      bookingUrl: "https://booking.test/shop",
      webhookSecret: randomToken(16),
    },
    select: { id: true },
  });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

describe("capturing the link on sync", () => {
  it("stores the URL and BOTH permission flags", async () => {
    const a = appt({ confirmationPage: CONFIRMATION, canClientReschedule: true, canClientCancel: true });
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    expect(await visitFor(a.id)).toEqual({
      customerManageUrl: CONFIRMATION,
      customerCanReschedule: true,
      customerCanCancel: true,
    });
  });

  it("🔴 stores the URL but NOT permission when the shop has locked changes", async () => {
    // Exactly what Drick's live account returns today.
    const a = appt({ confirmationPage: CONFIRMATION, canClientReschedule: false, canClientCancel: false });
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    const v = await visitFor(a.id);
    expect(v.customerManageUrl).toBe(CONFIRMATION);
    expect(v.customerCanReschedule).toBe(false);
    expect(v.customerCanCancel).toBe(false);
  });

  it("an appointment with no confirmationPage degrades, it does not throw", async () => {
    // Acuity does not formally document the list response, so a missing field
    // has to be survivable rather than fatal to the whole sweep.
    const a = appt();
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    expect(await visitFor(a.id)).toEqual({
      customerManageUrl: null,
      customerCanReschedule: false,
      customerCanCancel: false,
    });
  });

  it("treats a missing permission flag as NOT permitted", async () => {
    // Absent must never read as allowed: the whole point is that the URL alone
    // is not consent.
    const a = appt({ confirmationPage: CONFIRMATION });
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    const v = await visitFor(a.id);
    expect(v.customerManageUrl).toBe(CONFIRMATION);
    expect(v.customerCanReschedule).toBe(false);
  });
});

describe("🔴 the refresh IS the backfill", () => {
  it("a later pass fills in a link that was missing before", async () => {
    // No bespoke migration: the half-hourly resync re-ingests the window, so
    // every existing upcoming booking picks the link up on the next sweep.
    const a = appt();
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    expect((await visitFor(a.id)).customerManageUrl).toBeNull();

    await ingestAppointment(await shopRow(), "scheduled", a.id, {
      ...a,
      confirmationPage: CONFIRMATION,
      canClientReschedule: true,
    });
    const v = await visitFor(a.id);
    expect(v.customerManageUrl).toBe(CONFIRMATION);
    expect(v.customerCanReschedule).toBe(true);
  });

  it("and REVOKES permission when the shop turns client changes off", async () => {
    // The direction that matters for trust: a shop that locks its calendar
    // must stop being advertised as reschedulable within one sweep.
    const a = appt({ confirmationPage: CONFIRMATION, canClientReschedule: true });
    await ingestAppointment(await shopRow(), "scheduled", a.id, a);
    expect((await visitFor(a.id)).customerCanReschedule).toBe(true);

    await ingestAppointment(await shopRow(), "scheduled", a.id, {
      ...a,
      canClientReschedule: false,
    });
    expect((await visitFor(a.id)).customerCanReschedule).toBe(false);
  });
});

/**
 * 🔴 A BOOKING THAT STAYS IN ACUITY IS MANAGED IN ACUITY - EVEN AFTER THE SWITCH.
 *
 * When a shop starts taking NEW bookings in ChairBack, its existing Acuity
 * appointments stay in Acuity. ChairBack holds no manage token for them, so
 * their reminder must keep pointing at Acuity's own page for that appointment -
 * never at "where Book goes", which would make a second booking instead.
 */
describe("after the shop starts taking bookings in ChairBack", () => {
  it("a visit still in Acuity keeps Acuity's manage link in its reminder", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "native", slug: `mlc-${randomToken(5)}`, compAccess: true, timezone: "UTC" },
    });
    const sent: SendEmailInput[] = [];
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: `t-${sent.length}`, status: "sent" as const };
    });
    try {
      const now = new Date();
      const a = appt({
        datetime: new Date(now.getTime() + 3 * 3600_000).toISOString(),
        confirmationPage: CONFIRMATION,
        canClientReschedule: true,
        canClientCancel: true,
      });
      await ingestAppointment(await shopRow(), "scheduled", a.id, a);
      await runSyncedVisitReminders(now);
      const mine = sent.filter((m) => m.to === a.email);
      expect(mine).toHaveLength(1);
      const content = `${mine[0]!.text ?? ""}\n${mine[0]!.html ?? ""}`;
      expect(content).toContain("app.acuityscheduling.com/schedule.php");
      expect(content).not.toContain("/book/");
    } finally {
      __setSendEmailForTests(undefined);
      await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "link", compAccess: false } });
    }
  });
});
