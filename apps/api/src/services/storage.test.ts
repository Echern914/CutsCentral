import { describe, expect, it } from "vitest";
import { storageAuthHeaders } from "./storage.js";

/**
 * The server key must work in BOTH Supabase formats, so rotating it to a new
 * secret key is a variable change rather than an outage. A new `sb_secret_`
 * key sent as a Bearer token is refused - every photo upload would fail.
 */
describe("storageAuthHeaders", () => {
  it("sends a new secret key ONLY as apikey (never as a Bearer token)", () => {
    expect(storageAuthHeaders("sb_secret_abc123")).toEqual({ apikey: "sb_secret_abc123" });
  });

  it("keeps sending a legacy JWT key both ways, as before", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload.sig";
    expect(storageAuthHeaders(jwt)).toEqual({ apikey: jwt, authorization: `Bearer ${jwt}` });
  });
});
