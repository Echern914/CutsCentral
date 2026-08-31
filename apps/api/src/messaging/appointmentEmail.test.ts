import { describe, expect, it } from "vitest";
import {
  buildAppointmentCanceledEmail,
  buildAppointmentConfirmationBody,
  buildAppointmentConfirmationEmail,
  buildAppointmentReminderBody,
  buildAppointmentReminderEmail,
  buildSyncedVisitReminderEmail,
} from "./templates.js";

/**
 * The appointment emails must offer ONE route to change a booking: the button.
 *
 * These emails used to end with "…or reply to this email", and clients did
 * exactly that - a tester's client tried to reschedule by replying. Replies go
 * NOWHERE: every appointment email is sent `from: EMAIL_FROM` (the platform
 * address) with no reply-to, so a reply lands in ChairBack's inbox, not with the
 * barber who could move the appointment.
 *
 * Nothing asserted this copy before, which is how it drifted out of step with
 * #225 (SMS off) and #218 (manage really reschedules). It is asserted now.
 */
const base = {
  firstName: "Casey",
  shopName: "Drick's Barbershop",
  serviceName: "Skin Fade",
  startsAt: new Date("2026-09-02T15:00:00Z"),
  timezone: "America/New_York",
  staffName: "Drick",
  manageToken: "tok_abc123",
};

describe("appointment emails point at the button, never at a reply", () => {
  for (const [name, build] of [
    ["confirmation", buildAppointmentConfirmationEmail],
    ["reminder", buildAppointmentReminderEmail],
  ] as const) {
    describe(name, () => {
      const email = build(base);

      it("renders a button that names the action, linking to the manage page", () => {
        expect(email.html).toContain("Reschedule or cancel");
        expect(email.html).toContain("/book/manage/tok_abc123");
        // It must be a real anchor, not just words - clients tap the button.
        expect(email.html).toMatch(/<a href="[^"]*\/book\/manage\/tok_abc123"/);
      });

      it("NEVER invites a reply - replies reach nobody who can reschedule", () => {
        expect(email.html.toLowerCase()).not.toContain("reply to this email");
        expect(email.html.toLowerCase()).not.toContain("just reply");
      });

      it("gives the same link in the plain-text half", () => {
        expect(email.text).toContain("/book/manage/tok_abc123");
        expect(email.text.toLowerCase()).toMatch(/reschedule or cancel/);
      });

      it("does not leak the raw token into the subject", () => {
        expect(email.subject).not.toContain("tok_abc123");
      });
    });
  }

  describe("synced booking (no ChairBack manage page)", () => {
    const email = buildSyncedVisitReminderEmail({
      firstName: "Casey",
      shopName: "Drick's Barbershop",
      serviceName: "Skin Fade",
      startsAt: base.startsAt,
      timezone: base.timezone,
    });

    it("offers no button, because there is no page to send them to", () => {
      expect(email.html).not.toContain("/book/manage/");
      expect(email.html).not.toContain("Reschedule or cancel");
    });

    it("points at the SHOP instead of a reply nobody reads", () => {
      expect(email.html.toLowerCase()).not.toContain("just reply");
      expect(email.html.toLowerCase()).not.toContain("reply to this email");
      expect(email.html).toContain("Drick&#39;s Barbershop");
    });
  });
});

/**
 * The confirmation email's KEEP-IT-HANDY row: "Add to Calendar" always, "Add
 * to Apple Wallet" only while the appointment pass type is configured, the
 * app-store CTA closing, the manage button untouched - and NONE of it in SMS.
 */
describe("calendar, wallet and the app CTA", () => {
  const dark = buildAppointmentConfirmationEmail(base);
  const lit = buildAppointmentConfirmationEmail({ ...base, walletPassAvailable: true });

  it("always offers Add to Calendar, in both halves", () => {
    for (const email of [dark, lit]) {
      expect(email.html).toContain("/api/book/manage/tok_abc123/calendar.ics");
      expect(email.html).toContain("Add to Calendar");
      expect(email.text).toContain("/api/book/manage/tok_abc123/calendar.ics");
    }
  });

  it("🔴 offers Apple Wallet ONLY when the pass type is configured", () => {
    // A button whose link 404s is worse than no button.
    expect(dark.html).not.toContain("wallet-pass");
    expect(dark.html).not.toContain("Apple Wallet");
    expect(dark.text).not.toContain("wallet-pass");

    expect(lit.html).toContain("/api/book/manage/tok_abc123/wallet-pass");
    expect(lit.html).toContain("Add to Apple Wallet");
    expect(lit.text).toContain("/api/book/manage/tok_abc123/wallet-pass");
  });

  it("wallet ACCOMPANIES the calendar link, never replaces it", () => {
    expect(lit.html).toContain("calendar.ics");
    expect(lit.html).toContain("wallet-pass");
  });

  it("keeps the manage button as the primary action", () => {
    for (const email of [dark, lit]) {
      expect(email.html).toContain("Reschedule or cancel");
      expect(email.html).toContain("/book/manage/tok_abc123");
    }
  });

  it("closes with the app-store CTA", () => {
    for (const email of [dark, lit]) {
      expect(email.html).toContain("https://apps.apple.com/app/id6783995804");
      expect(email.html).toContain("get the ChairBack app");
      expect(email.text).toContain("https://apps.apple.com/app/id6783995804");
    }
  });

  it("🔴 the CANCELLATION email carries none of it", () => {
    const canceled = buildAppointmentCanceledEmail({
      firstName: "Casey",
      shopName: "Drick's Barbershop",
      shopSlug: "dricks",
      serviceName: "Skin Fade",
      startsAt: base.startsAt,
      timezone: base.timezone,
      staffName: "Drick",
    });
    const both = canceled.html + "\n" + canceled.text;
    expect(both).not.toContain("calendar.ics");
    expect(both).not.toContain("wallet-pass");
    expect(both).not.toContain("Apple Wallet");
  });

  it("🔴 SMS stays untouched - no wallet, no ics, no store link (this phase)", () => {
    const confirmation = buildAppointmentConfirmationBody(base);
    const reminder = buildAppointmentReminderBody(base);
    for (const body of [confirmation, reminder]) {
      expect(body).not.toContain("calendar.ics");
      expect(body).not.toContain("wallet-pass");
      expect(body).not.toContain("apps.apple.com");
    }
  });
});
