import { describe, expect, it } from "vitest";
import { buildAppointmentConfirmationEmail, buildAppointmentReminderEmail } from "./templates.js";

/**
 * THE SHOP'S NOTE ON THE CONFIRMATION AND REMINDER EMAILS. A barber: "add
 * notes to the confirmations - please arrive 10 minutes early".
 */
const base = {
  firstName: "Casey",
  shopName: "Fade Street",
  serviceName: "Mens Haircut",
  startsAt: new Date("2026-10-07T18:00:00Z"),
  timezone: "America/New_York",
  staffName: "Dee",
  manageToken: "tok_123",
};

describe("the confirmation email", () => {
  it("🔴 carries the note under the shop's name, in the HTML and the text", () => {
    const email = buildAppointmentConfirmationEmail({
      ...base,
      clientNote: "Please arrive 10 minutes early.\nParking is out back.",
    });
    expect(email.html).toContain("A note from Fade Street");
    expect(email.html).toContain("Please arrive 10 minutes early.<br>Parking is out back.");
    expect(email.text).toContain("A note from Fade Street:\nPlease arrive 10 minutes early.\nParking is out back.");
  });

  it("🔴 the owner's words are escaped - never markup", () => {
    const email = buildAppointmentConfirmationEmail({
      ...base,
      clientNote: `<script>alert(1)</script><a href="https://evil.example">click</a>`,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain('<a href="https://evil.example"');
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("no note, or a blank one: nothing at all - no empty heading", () => {
    for (const clientNote of [null, undefined, "", "   \n  "]) {
      const email = buildAppointmentConfirmationEmail({ ...base, clientNote });
      expect(email.html).not.toContain("A note from");
      expect(email.text).not.toContain("A note from");
    }
  });
});

describe("the reminder email", () => {
  it("carries it too", () => {
    const email = buildAppointmentReminderEmail({ ...base, clientNote: "Please arrive 10 minutes early." });
    expect(email.html).toContain("A note from Fade Street");
    expect(email.text).toContain("Please arrive 10 minutes early.");
  });
});
