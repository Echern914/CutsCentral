import { describe, expect, it } from "vitest";
import { carriedExtraMin, movedLengthMin } from "./moveLength.js";

describe("movedLengthMin - a moved booking keeps its own minutes", () => {
  it("no overrides: the booking keeps its length exactly, add-on minutes included", () => {
    expect(movedLengthMin({ currentMin: 60, serviceMinAtOld: 30, serviceMinAtNew: 30 })).toEqual({
      lengthMin: 60,
      extraMin: 30,
    });
  });

  it("a plain booking is its service, with nothing extra to check", () => {
    expect(movedLengthMin({ currentMin: 30, serviceMinAtOld: 30, serviceMinAtNew: 30 })).toEqual({
      lengthMin: 30,
      extraMin: 0,
    });
  });

  it("the service part is re-measured; the add-on part is not", () => {
    // 30 + 30 on a Monday, moved to a 20-minute Friday: 20 + 30.
    expect(movedLengthMin({ currentMin: 60, serviceMinAtOld: 30, serviceMinAtNew: 20 })).toEqual({
      lengthMin: 50,
      extraMin: 30,
    });
  });

  it("a booking trimmed by hand keeps its trim, and is checked for the full service", () => {
    expect(movedLengthMin({ currentMin: 20, serviceMinAtOld: 30, serviceMinAtNew: 30 })).toEqual({
      lengthMin: 20,
      extraMin: 0,
    });
  });

  it("a trim can never wipe the booking out", () => {
    // A 60-minute service trimmed to 25, moved where the service is 20.
    const { lengthMin } = movedLengthMin({ currentMin: 25, serviceMinAtOld: 60, serviceMinAtNew: 20 });
    expect(lengthMin).toBe(20);
  });

  it("🔴 the extra the write checks is the extra the list asks for, at every new time", () => {
    for (const currentMin of [15, 20, 30, 45, 60, 90]) {
      for (const serviceMinAtOld of [20, 30, 60]) {
        const listAsks = carriedExtraMin({ currentMin, serviceMinAtOld });
        for (const serviceMinAtNew of [10, 20, 30, 60]) {
          const { lengthMin, extraMin } = movedLengthMin({ currentMin, serviceMinAtOld, serviceMinAtNew });
          expect(extraMin).toBe(listAsks);
          expect(extraMin).toBe(Math.max(0, lengthMin - serviceMinAtNew));
        }
      }
    }
  });
});
