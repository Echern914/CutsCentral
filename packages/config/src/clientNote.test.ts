import { describe, expect, it } from "vitest";
import { CLIENT_NOTE_MAX, clientNoteHeading, normalizeClientNote } from "./clientNote.js";

describe("normalizeClientNote", () => {
  it("keeps what the owner wrote, trimmed", () => {
    expect(normalizeClientNote("  Please arrive 10 minutes early.  ")).toBe("Please arrive 10 minutes early.");
  });

  it("🔴 blank is null - nothing is shown anywhere", () => {
    for (const raw of ["", "   ", "\n\n", null, undefined]) {
      expect(normalizeClientNote(raw)).toBeNull();
    }
  });

  it("keeps a paragraph break but collapses a run of blank lines", () => {
    expect(normalizeClientNote("Arrive early.\r\n\r\n\r\n\r\nParking out back.")).toBe(
      "Arrive early.\n\nParking out back.",
    );
  });

  it("does not cut an over-long note - the API refuses it instead", () => {
    const long = "a".repeat(CLIENT_NOTE_MAX + 50);
    expect(normalizeClientNote(long)).toBe(long);
  });

  it("the heading names the shop", () => {
    expect(clientNoteHeading("Drick's")).toBe("A note from Drick's");
  });
});
