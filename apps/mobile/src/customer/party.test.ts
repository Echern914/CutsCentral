import { describe, expect, it } from "vitest";
import { groupIntoParties, partyNames, partySummary, seatTitle, sharedStatus } from "./party";
import type { Appointment } from "./types";

const ZONE = "America/New_York";

function appt(id: string, startsAt: string, over: Partial<Appointment> = {}): Appointment {
  return {
    id,
    source: "chairback",
    status: "booked",
    statusLabel: "Booked",
    statusDetail: null,
    startsAt,
    endsAt: null,
    timezone: ZONE,
    serviceName: "Kids cut",
    providerName: "Dre",
    providerImageUrl: null,
    shop: { key: "s", name: "Alpha Cuts", logoUrl: null, city: null, region: null, timezone: ZONE },
    canManage: true,
    manageNote: null,
    ...over,
  };
}

const ids = (xs: Appointment[]) => xs.map((x) => x.id);

describe("groupIntoParties", () => {
  it("folds a party into one entry where its first member appeared, keeping the list's order", () => {
    const list = [
      appt("solo-1", "2026-11-09T14:00:00Z"),
      appt("mia", "2026-11-09T20:00:00Z", { partyKey: "g1" }),
      appt("other-shop", "2026-11-09T20:10:00Z"),
      appt("leo", "2026-11-09T20:30:00Z", { partyKey: "g1" }),
      appt("solo-2", "2026-11-10T14:00:00Z"),
    ];
    const entries = groupIntoParties(list);
    expect(entries.map((e) => (e.kind === "one" ? e.appt.id : `party:${ids(e.members).join("+")}`))).toEqual([
      "solo-1",
      "party:mia+leo",
      "other-shop",
      "solo-2",
    ]);
  });

  it("runs members soonest first even in a newest-first list", () => {
    const entries = groupIntoParties([
      appt("sam", "2026-10-01T21:00:00Z", { partyKey: "g1" }),
      appt("leo", "2026-10-01T20:30:00Z", { partyKey: "g1" }),
      appt("mia", "2026-10-01T20:00:00Z", { partyKey: "g1" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(ids((entries[0] as { members: Appointment[] }).members)).toEqual(["mia", "leo", "sam"]);
  });

  it("🔴 a party with one member left is an ordinary row, never '1 appointments'", () => {
    const entries = groupIntoParties([appt("leo", "2026-11-09T20:30:00Z", { partyKey: "g1" })]);
    expect(entries).toEqual([{ kind: "one", appt: expect.objectContaining({ id: "leo" }) }]);
  });

  it("keeps two parties apart", () => {
    const entries = groupIntoParties([
      appt("a1", "2026-11-09T20:00:00Z", { partyKey: "g1" }),
      appt("b1", "2026-11-09T20:10:00Z", { partyKey: "g2" }),
      appt("a2", "2026-11-09T20:30:00Z", { partyKey: "g1" }),
      appt("b2", "2026-11-09T20:40:00Z", { partyKey: "g2" }),
    ]);
    expect(entries.map((e) => (e.kind === "party" ? ids(e.members) : []))).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
    ]);
  });

  it("🔴 an older API that sends no key leaves every row on its own", () => {
    const entries = groupIntoParties([appt("x", "2026-11-09T20:00:00Z"), appt("y", "2026-11-09T20:30:00Z", { partyKey: null })]);
    expect(entries.map((e) => e.kind)).toEqual(["one", "one"]);
  });
});

describe("the words", () => {
  it("says how many and when, on the shop's clock", () => {
    const members = [appt("mia", "2026-11-09T20:00:00Z"), appt("leo", "2026-11-09T20:30:00Z"), appt("sam", "2026-11-09T21:00:00Z")];
    expect(partySummary(members, new Date("2026-11-09T15:00:00Z"))).toBe("3 appointments · Today at 3:00 PM");
  });

  it("joins names the way a person writes them, each one once", () => {
    const named = (...names: (string | null)[]) => names.map((personName) => ({ personName }));
    expect(partyNames(named("Mia"))).toBe("Mia");
    expect(partyNames(named("Mia", "Leo"))).toBe("Mia and Leo");
    expect(partyNames(named("Mia", "Leo", "Sam"))).toBe("Mia, Leo and Sam");
    expect(partyNames(named("Mia", "Mia"))).toBe("Mia");
    expect(partyNames(named(null, " Leo "))).toBe("Leo");
    expect(partyNames(named(null))).toBe("");
  });

  it("leads a row with whose it is, and falls back without a name", () => {
    expect(seatTitle({ personName: "Mia", serviceName: "Kids cut" })).toBe("Mia · Kids cut");
    expect(seatTitle({ personName: null, serviceName: "Kids cut" })).toBe("Kids cut");
    expect(seatTitle({ personName: "Mia", serviceName: null })).toBe("Mia · Appointment");
  });

  it("gives one status only when everyone shares it", () => {
    const booked = appt("a", "2026-11-09T20:00:00Z");
    expect(sharedStatus([booked, appt("b", "2026-11-09T20:30:00Z")])?.statusLabel).toBe("Booked");
    expect(sharedStatus([booked, appt("c", "2026-11-09T20:30:00Z", { status: "no_show", statusLabel: "No show" })])).toBeNull();
    // Same status, different words: an unfinished hold is "requested" with its own label.
    expect(sharedStatus([appt("r1", "2026-11-09T20:00:00Z", { status: "requested", statusLabel: "Requested" }), appt("r2", "2026-11-09T20:30:00Z", { status: "requested", statusLabel: "Not booked yet" })])).toBeNull();
  });
});
