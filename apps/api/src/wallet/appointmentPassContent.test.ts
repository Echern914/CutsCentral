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

const {
  appointmentPassExpiration,
  BOOKED_PASS_GRACE_MS,
  buildAppointmentPassJson,
  confirmationReference,
  finishedPassLabel,
} = await import("./appointmentPass.js");
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
    nonRefundable: false,
    id: "cmapptxxxxxxxxxxxxCJ4K2P",
    status: "BOOKED",
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    completedAt: null,
    canceledAt: null,
    updatedAt: new Date("2026-03-10T12:00:00.000Z"),
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

  it("🔴 a booking paid on NON-REFUNDABLE terms says so - its own terms, not the shop's today", () => {
    const deposit = { paymentsMode: "deposit" as const, cancelWindowHours: 24, cancelFeeBps: 5000, depositAmountCents: 2000 };
    const kept = fields(buildAppointmentPassJson(source({ paymentsLive: true, nonRefundable: true }, deposit)));
    expect(kept.policy).toBe("what was paid at booking is not refunded on a cancellation");
    // Same shop, a booking made before the switch: still the fee policy it was booked on.
    const before = fields(buildAppointmentPassJson(source({ paymentsLive: true, nonRefundable: false }, deposit)));
    expect(before.policy).toContain("free up to 24h before");
  });

  it("🔴 still says so after the shop leaves deposit mode or Stripe - the engine keeps it either way", () => {
    for (const shopNow of [
      { paymentsMode: "off" as const },
      { paymentsMode: "card_on_file" as const },
      { paymentsMode: "deposit" as const, requireBookingApproval: true },
    ]) {
      const f = fields(buildAppointmentPassJson(source({ paymentsLive: true, nonRefundable: true }, shopNow)));
      expect(f.policy).toBe("what was paid at booking is not refunded on a cancellation");
    }
    const disconnected = fields(
      buildAppointmentPassJson(source({ paymentsLive: false, nonRefundable: true }, { paymentsMode: "deposit" })),
    );
    expect(disconnected.policy).toBe("what was paid at booking is not refunded on a cancellation");
  });
});

describe("relevance and expiry", () => {
  it("surfaces on the lock screen around the start, and expires a short grace after the end", () => {
    const pass = buildAppointmentPassJson(source());
    expect(pass.relevantDate).toBe(STARTS_AT.toISOString());
    // 🔴 Two hours, not a day: the promotion job completes the booking soon
    // after it ends, and this grace only covers a completion that never lands.
    expect(BOOKED_PASS_GRACE_MS).toBe(2 * 60 * 60 * 1000);
    expect(pass.expirationDate).toBe("2026-03-14T20:30:00.000Z");
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

describe("a finished appointment says what happened", () => {
  const FINISHED = new Date("2026-03-14T18:25:00.000Z");
  const label = (pass: Record<string, unknown>) =>
    (pass.eventTicket as { primaryFields: Array<{ label: string }> }).primaryFields[0]!
      .label;

  it("🔴 COMPLETED reads COMPLETED, voided, expiring when it was completed", () => {
    // A customer whose cut is done used to read "CANCELED" on their phone.
    const pass = buildAppointmentPassJson(
      source({ status: "COMPLETED", completedAt: FINISHED }),
    );
    expect(label(pass)).toBe("COMPLETED");
    expect(pass.voided).toBe(true);
    expect(pass.expirationDate).toBe(FINISHED.toISOString());
    // The time stays on the face: it is still the record of the visit.
    expect(fields(pass).when).toBe("2:00 - 2:30 PM");
  });

  it("🔴 NO_SHOW reads MISSED, voided, expiring at the no-show write", () => {
    const pass = buildAppointmentPassJson(
      source({ status: "NO_SHOW", updatedAt: FINISHED }),
    );
    expect(label(pass)).toBe("MISSED");
    expect(pass.voided).toBe(true);
    expect(pass.expirationDate).toBe(FINISHED.toISOString());
  });

  it("CANCELED still reads CANCELED, voided, expiring when it was canceled", () => {
    const canceledAt = new Date("2026-03-12T09:00:00.000Z");
    const pass = buildAppointmentPassJson(source({ status: "CANCELED", canceledAt }));
    expect(label(pass)).toBe("CANCELED");
    expect(pass.voided).toBe(true);
    expect(pass.expirationDate).toBe(canceledAt.toISOString());
  });

  it("relevantDate stays the start for every status", () => {
    for (const status of ["COMPLETED", "NO_SHOW", "CANCELED"]) {
      const pass = buildAppointmentPassJson(
        source({ status, completedAt: FINISHED, canceledAt: FINISHED }),
      );
      expect(pass.relevantDate).toBe(STARTS_AT.toISOString());
    }
  });

  it("labels: anything that is not a known ending keeps CANCELED", () => {
    expect(finishedPassLabel("COMPLETED")).toBe("COMPLETED");
    expect(finishedPassLabel("NO_SHOW")).toBe("MISSED");
    expect(finishedPassLabel("CANCELED")).toBe("CANCELED");
    expect(finishedPassLabel("PENDING")).toBe("CANCELED");
  });

  it("a finished row with no stamp (older data) falls back to the end-plus-grace rule", () => {
    const fallback = new Date(ENDS_AT.getTime() + BOOKED_PASS_GRACE_MS);
    const base = { endsAt: ENDS_AT, completedAt: null, canceledAt: null, updatedAt: FINISHED };
    expect(appointmentPassExpiration({ ...base, status: "COMPLETED" })).toEqual(fallback);
    expect(appointmentPassExpiration({ ...base, status: "CANCELED" })).toEqual(fallback);
    expect(appointmentPassExpiration({ ...base, status: "PENDING" })).toEqual(fallback);
    // A BOOKED row ignores any stamp it carries: it has not finished.
    expect(
      appointmentPassExpiration({ ...base, status: "BOOKED", completedAt: FINISHED }),
    ).toEqual(fallback);
  });

  it("🔴 the back of the pass never promises to remove itself", () => {
    // Wallet decides how an expired or voided pass is shown; ChairBack cannot
    // take a pass off a phone and must not say it will.
    const back = JSON.stringify(
      (buildAppointmentPassJson(source({ status: "COMPLETED", completedAt: FINISHED }))
        .eventTicket as { backFields: unknown }).backFields,
    );
    expect(back).not.toMatch(/\b(delete|remove|disappear)/i);
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
