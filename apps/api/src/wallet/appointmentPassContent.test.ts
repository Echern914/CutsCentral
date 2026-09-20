import { describe, expect, it } from "vitest";

/**
 * What is actually PRINTED on an appointment pass.
 *
 * This is the half of the feature with all the requirements in it, and until
 * buildAppointmentPassJson was split out it could not be tested at all: the
 * only entry point built AND signed, so asserting that the pass shows an end
 * time needed an Apple certificate. It does not. Signing is covered separately
 * in appointmentPassSigning.test.ts.
 *
 * Env before the import: the wallet modules freeze apiEnv() at module scope.
 */
process.env.WALLET_APPT_PASS_TYPE_ID = "pass.test.chairback.appointment";
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_APPT_PASS_CERT_BASE64 = Buffer.from("c").toString("base64");
process.env.WALLET_APPT_PASS_KEY_BASE64 = Buffer.from("k").toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("w").toString("base64");
process.env.APP_BASE_URL = "https://getchairback.com";

const { buildAppointmentPassJson, confirmationReference } = await import(
  "./appointmentPass.js"
);
type Source = Parameters<typeof buildAppointmentPassJson>[0];

/**
 * 🔴 A FIXED PAST INSTANT, never the real clock. A hard-coded future date goes
 * red on every branch the day it passes, and this suite asserts on formatted
 * wall-clock times that must not move.
 *
 * 2026-03-14T18:00:00Z is 2:00 PM in New York (EDT, UTC-4). The shop below is
 * in New York and the appointment runs 30 minutes.
 */
const STARTS_AT = new Date("2026-03-14T18:00:00.000Z");
const ENDS_AT = new Date("2026-03-14T18:30:00.000Z");

function source(over: Partial<Source> = {}, shopOver: Partial<Source["shop"]> = {}): Source {
  return {
    paymentsLive: false,
    id: "cmapptxxxxxxxxxxxxCJ4K2P",
    status: "BOOKED",
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    firstName: "Casey",
    manageToken: "mt_abc123",
    service: { name: "Skin Fade" },
    staff: { name: "Sam" },
    ...over,
    shop: {
      name: "Chern Cuts",
      timezone: "America/New_York",
      accentColor: "#D4AF37",
      addressStreet: "12 Main St",
      addressCity: "Brooklyn",
      addressRegion: "NY",
      addressPostal: "11201",
      latitude: null,
      longitude: null,
      twilioNumber: "+15551234567",
      paymentsMode: "off",
      cancelWindowHours: 0,
      cancelFeeBps: 0,
      depositAmountCents: null,
      requireBookingApproval: false,
      connectChargesEnabled: false,
      stripeConnectAccountId: null,
      chargeCardOnFileFees: false,
      ...shopOver,
    },
  };
}

/** Every field on the pass face and back, flattened for easy lookup. */
function fields(pass: Record<string, unknown>): Record<string, string> {
  const ticket = pass.eventTicket as Record<string, Array<Record<string, string>>>;
  const all = [
    ...(ticket.headerFields ?? []),
    ...(ticket.primaryFields ?? []),
    ...(ticket.secondaryFields ?? []),
    ...(ticket.auxiliaryFields ?? []),
    ...(ticket.backFields ?? []),
  ];
  return Object.fromEntries(all.map((f) => [f.key, f.value]));
}

describe("what the customer reads on the pass", () => {
  it("🔴 shows the START AND THE END, in the SHOP's timezone", () => {
    // The pass used to print the start only - the one question a customer in a
    // chair cannot answer from it is "how long am I here for?". The timezone is
    // the shop's, never the phone's: someone who books in Brooklyn and opens
    // the pass in Denver must still see 2:00, which is when they are expected.
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.when).toBe("2:00 - 2:30 PM");
  });

  it("keeps both meridiems when the appointment straddles noon", () => {
    const f = fields(
      buildAppointmentPassJson(
        source({
          startsAt: new Date("2026-03-14T15:30:00.000Z"), // 11:30 AM NY
          endsAt: new Date("2026-03-14T16:30:00.000Z"), // 12:30 PM NY
        }),
      ),
    );
    expect(f.when).toBe("11:30 AM - 12:30 PM");
  });

  it("shows the local DATE as the field label", () => {
    const pass = buildAppointmentPassJson(source());
    const primary = (pass.eventTicket as { primaryFields: Array<{ label: string }> })
      .primaryFields[0]!;
    expect(primary.label).toBe("SAT, MAR 14");
  });

  it("shows the service, the barber and the attendee", () => {
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.service).toBe("Skin Fade");
    expect(f.with).toBe("Sam");
    expect(f.name).toBe("Casey");
  });

  it("shows the address from the ONE formatter", () => {
    // Hand-joining the address columns here is how a second, quietly different
    // version of the shop's address starts existing - the email, the reminder
    // and the pass have to agree about where the shop is.
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.address).toBe("12 Main St, Brooklyn, NY 11201");
  });

  it("🔴 shows the shop's PUBLIC line, never the barber's own mobile", () => {
    // notifyPhone is the barber's personal number, kept for lead alerts.
    // Printing it on a pass every customer keeps forever would publish it.
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.phone).toBe("+15551234567");
  });

  it("links to the management page", () => {
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.manage).toBe("https://getchairback.com/book/manage/mt_abc123");
  });

  it("carries a confirmation reference a customer can read out loud", () => {
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.ref).toBe("CJ4K2P");
    expect(f.ref).toBe(confirmationReference("cmapptxxxxxxxxxxxxCJ4K2P"));
  });

  it("omits a field rather than printing an empty one", () => {
    const pass = buildAppointmentPassJson(
      source(
        { staff: null, firstName: null },
        { twilioNumber: null, addressStreet: null, addressCity: null, addressRegion: null, addressPostal: null },
      ),
    );
    const f = fields(pass);
    expect(f.with).toBeUndefined();
    expect(f.phone).toBeUndefined();
    expect(f.address).toBeUndefined();
  });
});

describe("the cancellation policy on the back", () => {
  it("says free cancellation when the shop takes no money", () => {
    const f = fields(buildAppointmentPassJson(source()));
    expect(f.policy).toBe("free cancellation any time before the appointment");
  });

  it("🔴 quotes the real fee in the SAME words as the email and the receptionist", () => {
    // A pass a customer keeps for weeks is the worst possible place for a
    // second, drifting copy of what a late cancellation costs.
    const f = fields(
      buildAppointmentPassJson(
        source(
          { paymentsLive: true },
          {
            paymentsMode: "deposit",
            cancelWindowHours: 24,
            cancelFeeBps: 5000,
            depositAmountCents: 2000,
          },
        ),
      ),
    );
    expect(f.policy).toContain("free up to 24h before");
    expect(f.policy).toContain("50%");
  });

  it("🔴 says FREE when the shop cannot actually take money, whatever its settings say", () => {
    // paymentsMode is INTENT; paymentsLive is CAPABILITY. A shop can sit in
    // deposit mode through all of Connect onboarding and collect nothing the
    // whole time. Quoting a percentage of money we never took is a threat we
    // cannot carry out - and on a pass the customer keeps, it is one they
    // would read for weeks.
    const f = fields(
      buildAppointmentPassJson(
        source(
          { paymentsLive: false },
          { paymentsMode: "deposit", cancelWindowHours: 24, cancelFeeBps: 5000 },
        ),
      ),
    );
    expect(f.policy).toBe("free cancellation any time before the appointment");
  });
});

describe("relevance and expiry", () => {
  it("surfaces on the lock screen around the start, and expires after the end", () => {
    const pass = buildAppointmentPassJson(source());
    expect(pass.relevantDate).toBe(STARTS_AT.toISOString());
    // A day past the end the pass is meaningless; this is Wallet's cleanup hint.
    expect(pass.expirationDate).toBe(
      new Date(ENDS_AT.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("🔴 omits `locations` when the shop has no coordinates", () => {
    // Apple takes lat/lng and nothing else. Guessing a point from the address
    // would buzz a customer at the wrong building, which is worse than never
    // buzzing at all - so no coordinates means no location relevance, and the
    // pass stays completely valid on time relevance alone.
    expect(buildAppointmentPassJson(source()).locations).toBeUndefined();
  });

  it("emits `locations` when the shop has them", () => {
    const pass = buildAppointmentPassJson(
      source({}, { latitude: 40.6955, longitude: -73.9903 }),
    );
    expect(pass.locations).toEqual([
      {
        latitude: 40.6955,
        longitude: -73.9903,
        relevantText: "Chern Cuts - 2:00 - 2:30 PM",
      },
    ]);
  });
});

describe("a dead appointment", () => {
  it("🔴 comes back VOIDED, not missing", () => {
    // Devices that already added the pass re-fetch through this builder after a
    // cancellation poke. Returning nothing would leave a pass on the customer's
    // phone still claiming an appointment they no longer have; `voided` is how
    // Wallet is told to grey it out.
    const pass = buildAppointmentPassJson(source({ status: "CANCELED" }));
    expect(pass.voided).toBe(true);
    const primary = (pass.eventTicket as { primaryFields: Array<{ label: string }> })
      .primaryFields[0]!;
    expect(primary.label).toBe("CANCELED");
  });

  it("a live appointment is not voided", () => {
    expect(buildAppointmentPassJson(source()).voided).toBeUndefined();
  });
});

describe("identity", () => {
  it("serial number is the appointment, so one appointment has ONE pass", () => {
    // 🔴 This is what stops a reschedule issuing a SECOND pass: Wallet replaces
    // a pass with the same serial + type rather than adding another.
    const pass = buildAppointmentPassJson(source());
    expect(pass.serialNumber).toBe("cmapptxxxxxxxxxxxxCJ4K2P");
    expect(pass.passTypeIdentifier).toBe("pass.test.chairback.appointment");
  });

  it("a reschedule keeps the serial and only moves the time", () => {
    const before = buildAppointmentPassJson(source());
    const after = buildAppointmentPassJson(
      source({
        startsAt: new Date("2026-03-14T20:00:00.000Z"),
        endsAt: new Date("2026-03-14T20:30:00.000Z"),
      }),
    );
    expect(after.serialNumber).toBe(before.serialNumber);
    expect(fields(after).when).toBe("4:00 - 4:30 PM");
    expect(after.relevantDate).not.toBe(before.relevantDate);
  });
});
