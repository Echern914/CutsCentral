import { describe, expect, it } from "vitest";
import { BookingQuestionKind } from "@chairback/db";
import { BUSINESS_TYPES, BUSINESS_TYPE_IDS } from "@chairback/config";
import {
  BOOKING_QUESTION_KINDS,
  questionsForService,
  readIntakeSnapshot,
  resolveIntake,
  type PublicBookingQuestion,
} from "./bookingIntake.js";

/**
 * What a shop asks a customer before it can do the job, and what happens when
 * the answer is missing or unusable.
 *
 * Every refusal here is a booking that does not happen, so each one has to be
 * worth it: a mobile mechanic cannot drive to an address he was not given, but
 * a barber who asks four questions for a fade loses customers. The rules below
 * are the line between those two.
 */
function q(over: Partial<PublicBookingQuestion> = {}): PublicBookingQuestion {
  return {
    id: "q1",
    label: "Service address",
    helpText: null,
    kind: "address",
    required: true,
    options: [],
    serviceIds: [],
    ...over,
  };
}

describe("required answers", () => {
  it("refuses a blank required answer, naming the field the customer can fix", () => {
    const r = resolveIntake([q()], []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The id is what lets the form put the message under THAT input rather
    // than at the top of a page the customer then has to search.
    expect(r.questionId).toBe("q1");
    expect(r.message).toBe("Service address is required.");
  });

  it("treats whitespace as blank - a space is not an address", () => {
    const r = resolveIntake([q()], [{ questionId: "q1", value: "   " }]);
    expect(r.ok).toBe(false);
  });

  it("accepts a real answer and trims it", () => {
    const r = resolveIntake([q()], [{ questionId: "q1", value: "  12 Main St, Newark NJ  " }]);
    expect(r).toEqual({
      ok: true,
      snapshot: [
        { questionId: "q1", label: "Service address", kind: "address", value: "12 Main St, Newark NJ" },
      ],
    });
  });
});

describe("optional answers", () => {
  it("a blank optional answer is left OUT of the snapshot, not stored empty", () => {
    // An empty row on the barber's sheet is noise pretending to be information.
    const r = resolveIntake([q({ required: false })], [{ questionId: "q1", value: "" }]);
    expect(r).toEqual({ ok: true, snapshot: [] });
    const none = resolveIntake([q({ required: false })], undefined);
    expect(none).toEqual({ ok: true, snapshot: [] });
  });
});

describe("what the shop did not ask", () => {
  it("🔴 drops an answer to an unknown question instead of storing it", () => {
    // A stale id from a cached page, or a crafted one, must buy nothing: only
    // what this shop asks can end up on its bookings.
    const r = resolveIntake([q({ required: false })], [
      { questionId: "not-a-question", value: "junk" },
      { questionId: "q1", value: "12 Main St" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.map((a) => a.questionId)).toEqual(["q1"]);
  });

  it("a repeated id takes the last value rather than refusing the booking", () => {
    const r = resolveIntake([q()], [
      { questionId: "q1", value: "old" },
      { questionId: "q1", value: "new" },
    ]);
    expect(r.ok && r.snapshot[0]!.value).toBe("new");
  });
});

describe("per-kind rules", () => {
  it("a select must be one of the offered options", () => {
    const question = q({ kind: "select", required: false, options: ["Yes", "No"] });
    expect(resolveIntake([question], [{ questionId: "q1", value: "Maybe" }]).ok).toBe(false);
    expect(resolveIntake([question], [{ questionId: "q1", value: "Yes" }]).ok).toBe(true);
  });

  it("an email question uses the same permissive rule as the booking form", () => {
    const question = q({ kind: "email", required: false });
    expect(resolveIntake([question], [{ questionId: "q1", value: "not an email" }]).ok).toBe(false);
    expect(resolveIntake([question], [{ questionId: "q1", value: "a+tag@sub.example.co.uk" }]).ok).toBe(
      true,
    );
  });

  it("a number question refuses text", () => {
    const question = q({ kind: "number", required: false });
    expect(resolveIntake([question], [{ questionId: "q1", value: "soon" }]).ok).toBe(false);
    expect(resolveIntake([question], [{ questionId: "q1", value: "2014" }]).ok).toBe(true);
  });

  it("refuses an over-long answer rather than silently truncating it", () => {
    // Half an address stored as though it were the whole one sends a mechanic
    // to the wrong street.
    const r = resolveIntake([q()], [{ questionId: "q1", value: "x".repeat(301) }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("too long");
    // A paragraph question has room for a paragraph.
    expect(
      resolveIntake([q({ kind: "textarea", required: false })], [
        { questionId: "q1", value: "x".repeat(301) },
      ]).ok,
    ).toBe(true);
  });
});

describe("the snapshot", () => {
  it("follows the SHOP's order, not the order the answers arrived in", () => {
    const questions = [
      q({ id: "a", label: "Service address", required: false }),
      q({ id: "b", label: "Vehicle year", kind: "text", required: false }),
    ];
    const r = resolveIntake(questions, [
      { questionId: "b", value: "2014" },
      { questionId: "a", value: "12 Main St" },
    ]);
    expect(r.ok && r.snapshot.map((x) => x.label)).toEqual(["Service address", "Vehicle year"]);
  });

  it("carries the LABEL, so renaming or deleting a question never rewrites history", () => {
    const r = resolveIntake([q()], [{ questionId: "q1", value: "12 Main St" }]);
    expect(r.ok && r.snapshot[0]!.label).toBe("Service address");
  });
});

describe("reading a stored snapshot back", () => {
  it("round-trips what resolveIntake wrote", () => {
    const r = resolveIntake([q()], [{ questionId: "q1", value: "12 Main St" }]);
    expect(r.ok && readIntakeSnapshot(r.snapshot)).toEqual(r.ok ? r.snapshot : null);
  });

  it("survives anything unexpected in the column - the sheet must still render", () => {
    expect(readIntakeSnapshot(null)).toEqual([]);
    expect(readIntakeSnapshot("nonsense")).toEqual([]);
    expect(readIntakeSnapshot([null, 3, { label: "x" }, { value: "y" }])).toEqual([]);
    // A row with an unknown kind renders as plain text rather than vanishing.
    expect(readIntakeSnapshot([{ label: "L", value: "V", kind: "hologram" }])).toEqual([
      { questionId: "", label: "L", kind: "text", value: "V" },
    ]);
  });
});

describe("config and the database agree on what a question can be", () => {
  it("🔴 the kinds in config are exactly the Prisma enum's values", () => {
    // Config cannot import the database client, so nothing but this test stops
    // a kind being added in one place and rendering nowhere in the other.
    expect([...BOOKING_QUESTION_KINDS].sort()).toEqual(Object.values(BookingQuestionKind).sort());
  });

  it("every business type's suggested questions use a real kind", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      for (const t of BUSINESS_TYPES[id].intakeTemplates) {
        expect(BOOKING_QUESTION_KINDS, `${id}/${t.key}`).toContain(t.kind);
        // A select with no options is a field nobody can answer.
        if (t.kind === "select") expect((t.options ?? []).length, `${id}/${t.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("template keys are unique within a type - they are the idempotency key", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const keys = BUSINESS_TYPES[id].intakeTemplates.map((t) => t.key);
      expect(new Set(keys).size, id).toBe(keys.length);
    }
  });

  it("🔴 only the mechanic and the tattooer require anything", () => {
    // Required fields cost bookings. They are justified where the work is
    // impossible without the answer, and nowhere else.
    const requiring = BUSINESS_TYPE_IDS.filter((id) =>
      BUSINESS_TYPES[id].intakeTemplates.some((t) => t.required),
    );
    expect(requiring.sort()).toEqual(["detailing", "mechanic", "tattoo"]);
  });
});

/**
 * WHICH SERVICES ASK WHAT.
 *
 * A mobile mechanic drives to some jobs and does others in his own bay. Asking
 * every customer for a street address he does not need is how a booking form
 * starts costing bookings - so a question can be scoped, and the list the
 * server ENFORCES is filtered the same way the form filtered it.
 */
describe("questionsForService", () => {
  const shopWide = q({ id: "all", label: "Anything I should know?", serviceIds: [] });
  const mobileOnly = q({ id: "addr", label: "Service address", serviceIds: ["mobile"] });
  const all = [shopWide, mobileOnly];

  it("an unscoped question is asked on every service", () => {
    expect(questionsForService(all, "in-shop").map((x) => x.id)).toEqual(["all"]);
    expect(questionsForService(all, "mobile").map((x) => x.id)).toEqual(["all", "addr"]);
  });

  it("🔴 a scoped question never reaches a service it was not scoped to", () => {
    // This is the whole point: the in-shop job must not ask where to drive.
    expect(questionsForService(all, "in-shop").some((x) => x.id === "addr")).toBe(false);
  });

  it("keeps the shop's order", () => {
    const reversed = [mobileOnly, shopWide];
    expect(questionsForService(reversed, "mobile").map((x) => x.id)).toEqual(["addr", "all"]);
  });

  it("🔴 a REQUIRED question cannot refuse a service that never asked it", () => {
    // Filtering first is what makes this true: resolveIntake only ever sees
    // the questions this service asks, so a required address scoped to the
    // mobile job can never block an in-shop booking with no answer.
    const required = q({ id: "addr", label: "Service address", required: true, serviceIds: ["mobile"] });
    expect(resolveIntake(questionsForService([required], "in-shop"), []).ok).toBe(true);
    expect(resolveIntake(questionsForService([required], "mobile"), []).ok).toBe(false);
  });
});
