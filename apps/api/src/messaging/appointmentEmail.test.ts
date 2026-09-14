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

    it("🔴 never dresses the booking page up as a reschedule link", () => {
      // The shop's booking URL books a NEW appointment; it cannot move this
      // one. A customer who taps "Reschedule" and lands there books a second
      // slot believing the first is gone - the shop loses a chair AND still
      // holds the original.
      expect(email.html).not.toContain("Reschedule");
      expect(email.text).not.toContain("Reschedule");
    });

    it("points at the SHOP instead of a reply nobody reads", () => {
      expect(email.html.toLowerCase()).not.toContain("just reply");
      expect(email.html.toLowerCase()).not.toContain("reply to this email");
      expect(email.html).toContain("Drick&#39;s Barbershop");
    });

    it("🔴 never dresses the booking page up as a reschedule link", () => {
      // The shop's booking URL books a NEW appointment; it cannot move this
      // one, which lives in the shop's own Acuity/Square calendar. A customer
      // who taps "Reschedule" and lands there books a second slot believing
      // the first is gone - the shop loses a chair AND still has the original.
      expect(email.html).not.toContain("Reschedule");
      expect(email.text).not.toContain("Reschedule");
    });
  });
});

/**
 * 🔴 EVERY REMINDER CARRIES THE APP LINK, not just the confirmation.
 *
 * A reminder is the most-opened mail this product sends - it arrives when
 * somebody is already thinking about the appointment - and it was the one
 * customer email with no way into the app. Both kinds carry it now: the native
 * one alongside its manage button, and the synced one where it is the ONLY
 * thing a customer can act on.
 */
describe("the app link on reminders", () => {
  const nativeReminder = buildAppointmentReminderEmail(base);
  const syncedReminder = buildSyncedVisitReminderEmail({
    firstName: "Casey",
    shopName: "Drick's Barbershop",
    serviceName: "Skin Fade",
    startsAt: base.startsAt,
    timezone: base.timezone,
  });

  for (const [name, email] of [
    ["native", nativeReminder],
    ["synced", syncedReminder],
  ] as const) {
    it(`${name} reminder links to the App Store, in both halves`, () => {
      expect(email.html).toContain("https://apps.apple.com/app/id6783995804");
      expect(email.html).toContain("get the ChairBack app");
      expect(email.text).toContain("https://apps.apple.com/app/id6783995804");
    });
  }

  it("does not cost the native reminder its manage button", () => {
    // The app link is a quiet footer row; the gold button stays the one loud
    // action, because moving the appointment is still the point of the mail.
    expect(nativeReminder.html).toContain("Reschedule or cancel");
    expect(nativeReminder.html).toContain("/book/manage/");
  });
});

/**
 * A SYNCED reminder may carry the PROVIDER's own manage page - but only when
 * the provider also says the customer is allowed to use it.
 *
 * 🔴 THE TWO ARE NOT THE SAME FACT. Acuity returns a confirmationPage for every
 * appointment, including ones the shop has locked; verified against a live
 * account on 2026-09-13, where every upcoming appointment had a URL and
 * `canClientReschedule` was false on all of them. A button onto a page that
 * offers no reschedule is the same failure as pointing at the booking page.
 */
describe("synced booking WITH a permitted provider link", () => {
  const base2 = {
    firstName: "Casey",
    shopName: "Drick's Barbershop",
    serviceName: "Skin Fade",
    startsAt: base.startsAt,
    timezone: base.timezone,
  };
  const ACUITY = "https://app.acuityscheduling.com/schedule.php?owner=27210928&id[]=abc123&action=appt";

  it("offers a real button when a permitted link is passed", () => {
    const email = buildSyncedVisitReminderEmail({ ...base2, manageUrl: ACUITY });
    expect(email.html).toContain("Reschedule or cancel");
    expect(email.html).toContain("schedule.php");
    expect(email.text).toContain("Reschedule or cancel:");
    // ...and stops telling them to go and find the shop themselves.
    expect(email.html).not.toContain("Contact Drick&#39;s Barbershop directly");
  });

  it("🔴 falls back to 'contact the shop' when no link is passed", () => {
    // Which is what the caller does whenever canClientReschedule is false.
    for (const manageUrl of [null, undefined]) {
      const email = buildSyncedVisitReminderEmail({ ...base2, manageUrl });
      expect(email.html).toContain("Contact Drick&#39;s Barbershop directly");
      expect(email.html).not.toContain("Reschedule or cancel");
      expect(email.text).not.toContain("Reschedule or cancel");
    }
  });

  it("escapes the provider URL into the href rather than trusting it", () => {
    // It is a third party's string arriving over the wire and going into an
    // HTML attribute; `[]` and `&` in Acuity's own format must survive intact.
    const email = buildSyncedVisitReminderEmail({ ...base2, manageUrl: ACUITY });
    expect(email.html).toContain("&amp;id[]=abc123");
    expect(email.html).not.toContain('"><script');
  });
});

/**
 * The confirmation email's KEEP-IT-HANDY row: "Add to Calendar" always, "Add
 * to Apple Wallet" only while the appointment pass type is configured, the
 * app-store CTA closing, the manage button untouched - and NONE of it in SMS.
 */
describe("a standing appointment is never rounded up", () => {
  /**
   * 🔴 The confirmation email said NOTHING about a series, while the booking
   * route carried a comment claiming "the email says it repeats". A customer
   * who asked for twelve and got one received an ordinary one-date
   * confirmation and had no way to learn the other eleven never happened.
   */
  it("names the shortfall when dates were skipped", () => {
    const e = buildAppointmentConfirmationEmail({
      ...base,
      series: { requested: 12, confirmed: 1, dates: ["Sun, Sep 27 at 11:00 AM"] },
    });
    expect(e.text).toContain("1 of the 12 visits you asked for are booked");
    expect(e.text).toContain("could not book the other 11");
    expect(e.html).toContain("1 of the 12 visits");
    // The one date that IS real is named.
    expect(e.text).toContain("Sun, Sep 27 at 11:00 AM");
    // And it must never claim the whole series landed.
    expect(e.text).not.toContain("all 12 visits are booked");
  });

  it("says so plainly when every date landed", () => {
    const e = buildAppointmentConfirmationEmail({
      ...base,
      series: { requested: 3, confirmed: 3, dates: ["a", "b", "c"] },
    });
    expect(e.text).toContain("all 3 visits are booked");
    expect(e.text).not.toContain("could not book");
  });

  it("a single booking carries no series wording at all", () => {
    const e = buildAppointmentConfirmationEmail(base);
    expect(e.text).not.toContain("This repeats");
    expect(e.html).not.toContain("This repeats");
  });
});

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
