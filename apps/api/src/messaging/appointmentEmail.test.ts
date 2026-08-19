import { describe, expect, it } from "vitest";
import {
  buildAppointmentConfirmationEmail,
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
