import { describe, expect, it } from "vitest";
import type { AcuityAppointmentType } from "../acuity/types.js";
import {
  htmlToPlainText,
  nameKey,
  paletteKeyFor,
  planServiceImport,
} from "./acuityServiceImport.js";

/**
 * The rules of "Import services from Acuity" that need no database: which
 * Acuity types are imported, which are left out and why, and how a
 * description and a colour come across. Made-up data throughout.
 */

const type = (over: Partial<AcuityAppointmentType> & { id: string }): AcuityAppointmentType => ({
  name: "Service",
  active: true,
  duration: 30,
  price: "30.00",
  category: "",
  private: false,
  type: "service",
  ...over,
});

const nothing = { services: [], groups: [] };

describe("which types are imported", () => {
  it("an ordinary active public service is new, with its length, price and category", () => {
    const plan = planServiceImport(
      [type({ id: "1", name: "Classic Trim", duration: 45, price: "40.50", category: "Trims" })],
      nothing,
    );
    expect(plan.rows).toEqual([
      { acuityId: "1", name: "Classic Trim", durationMin: 45, price: 40.5, category: "Trims", status: "new" },
    ]);
    expect(plan.newGroups).toEqual(["Trims"]);
  });

  it("an inactive type is left out", () => {
    const plan = planServiceImport([type({ id: "1", active: false })], nothing);
    expect(plan.rows[0]!.status).toBe("inactive");
    expect(plan.newGroups).toEqual([]);
  });

  it("reads Acuity's flags in their string spellings too", () => {
    const plan = planServiceImport(
      [type({ id: "1", name: "A", active: "false" }), type({ id: "2", name: "B", private: "true" })],
      nothing,
    );
    expect(plan.rows.map((r) => r.status)).toEqual(["inactive", "private"]);
  });

  it("a private type is left out, because a ChairBack service is public", () => {
    const plan = planServiceImport([type({ id: "1", private: true })], nothing);
    expect(plan.rows[0]!.status).toBe("private");
  });

  it("a class is left out, whether Acuity says so by type or by class size", () => {
    const plan = planServiceImport(
      [type({ id: "1", name: "A", type: "class" }), type({ id: "2", name: "B", classSize: 8 })],
      nothing,
    );
    expect(plan.rows.map((r) => r.status)).toEqual(["class", "class"]);
  });

  it("a length Add service would refuse is left out", () => {
    const plan = planServiceImport(
      [
        type({ id: "1", name: "A", duration: 720 }),
        type({ id: "2", name: "B", duration: 0 }),
        type({ id: "3", name: "C", duration: null }),
      ],
      nothing,
    );
    expect(plan.rows.map((r) => r.status)).toEqual(["bad_length", "bad_length", "bad_length"]);
  });

  it("a type with no name is not listed at all", () => {
    expect(planServiceImport([type({ id: "1", name: "   " })], nothing).rows).toEqual([]);
  });
});

describe("already in ChairBack", () => {
  it("matches by name, trimmed, spaces collapsed, case ignored", () => {
    expect(nameKey("  Beard   TRIM ")).toBe(nameKey("beard trim"));
    const plan = planServiceImport([type({ id: "1", name: "Beard Trim" })], {
      services: [{ name: "  beard   TRIM ", serviceGroupId: null }],
      groups: [],
    });
    expect(plan.rows[0]!.status).toBe("exists");
  });

  it("punctuation still counts: a different spelling is a different service", () => {
    const plan = planServiceImport([type({ id: "1", name: "Beard-Trim" })], {
      services: [{ name: "Beard Trim", serviceGroupId: null }],
      groups: [],
    });
    expect(plan.rows[0]!.status).toBe("new");
  });

  it("a second Acuity type with the same name is imported once", () => {
    const plan = planServiceImport(
      [type({ id: "1", name: "Wash", category: "A" }), type({ id: "2", name: "wash", category: "B" })],
      nothing,
    );
    expect(plan.rows.map((r) => r.status)).toEqual(["new", "duplicate"]);
    expect(plan.newGroups).toEqual(["A"]);
  });

  it("a category that already has a group creates no new one", () => {
    const plan = planServiceImport([type({ id: "1", category: " trims " })], {
      services: [],
      groups: [{ id: "g1", name: "Trims" }],
    });
    expect(plan.newGroups).toEqual([]);
  });

  it("a name longer than a service name can be is compared as it will be saved", () => {
    const long = "x".repeat(130);
    const plan = planServiceImport([type({ id: "1", name: long })], {
      services: [{ name: "x".repeat(120), serviceGroupId: null }],
      groups: [],
    });
    expect(plan.rows[0]!.status).toBe("exists");
  });
});

describe("description as plain text", () => {
  it("keeps the words and line breaks, drops the markup", () => {
    expect(
      htmlToPlainText(
        "<p>Includes:</p><ul><li>Wash &amp; style</li><li>Hot&nbsp;towel</li></ul><p>Arrive <b>5 min</b> early<br>Thanks!</p>",
      ),
    ).toBe("Includes:\n• Wash & style\n• Hot towel\nArrive 5 min early\nThanks!");
  });

  it("decodes entities once, never twice", () => {
    expect(htmlToPlainText("Tom &amp;lt;3 &#39;quoted&#39; &lt;tag&gt;")).toBe("Tom &lt;3 'quoted' <tag>");
  });

  it("drops script and style content entirely", () => {
    expect(htmlToPlainText("<style>p{color:red}</style>Hi<script>alert(1)</script>")).toBe("Hi");
  });

  it("empty or missing is empty", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText("<p> </p>")).toBe("");
  });
});

describe("colour", () => {
  it("a colour that is clearly one of ours maps to it", () => {
    expect(paletteKeyFor("#F7A5A5")).toBe("red");
    expect(paletteKeyFor("#8ECDFF")).toBe("blue");
    expect(paletteKeyFor("#7AE08C")).toBe("green");
  });

  it("grey, near-white and near-black save no colour", () => {
    expect(paletteKeyFor("#AAAAAA")).toBeNull();
    expect(paletteKeyFor("#FDFDFB")).toBeNull();
    expect(paletteKeyFor("#0A0A0B")).toBeNull();
  });

  it("a hue between two of ours saves no colour rather than guessing", () => {
    // Lime sits between amber and green, more than 30 degrees from each.
    expect(paletteKeyFor("#B5E61D")).toBeNull();
  });

  it("anything unreadable saves no colour", () => {
    expect(paletteKeyFor(null)).toBeNull();
    expect(paletteKeyFor("blue")).toBeNull();
  });
});
