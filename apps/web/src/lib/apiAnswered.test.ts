import { describe, expect, it } from "vitest";
import { apiAnswered } from "./apiAnswered";

describe("apiAnswered: does this status settle a write?", () => {
  it("2xx and the API's own 4xx answers settle it", () => {
    for (const s of [200, 201, 400, 401, 403, 404, 409, 422, 429]) expect(apiAnswered(s)).toBe(true);
  });

  it("🔴 no response, a gateway error, or any 5xx: the outcome is UNKNOWN", () => {
    for (const s of [0, 500, 502, 503, 504]) expect(apiAnswered(s)).toBe(false);
  });
});
