import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { appAuthLanding } from "./appAuthLanding";
import { GET } from "@/app/app-auth/route";

/**
 * The app's session handoff can land on the page a tapped notification links
 * to - and on nothing outside the dashboard.
 */
describe("appAuthLanding", () => {
  it("🔴 lands on the appointment a notification linked to", () => {
    expect(appAuthLanding("/dashboard/booking?tab=Appointments&appointment=ap_1")).toBe(
      "/dashboard/booking?tab=Appointments&appointment=ap_1",
    );
  });

  it("🔴 anything else lands on /dashboard - never another site", () => {
    for (const next of [
      null,
      undefined,
      "",
      "https://evil.example/dashboard",
      "//evil.example/dashboard",
      "/dashboard//evil.example",
      "/dashboard\\evil",
      "/login",
      "/dashboards",
      "javascript:alert(1)",
    ]) {
      expect(appAuthLanding(next)).toBe("/dashboard");
    }
  });
});

describe("GET /app-auth", () => {
  const get = (qs: string) =>
    GET(new NextRequest(`https://getchairback.com/app-auth${qs}`, { headers: { authorization: "Bearer tok" } }));

  it("redirects to the linked page, with the session cookie set", async () => {
    const res = await get(`?next=${encodeURIComponent("/dashboard/booking?appointment=ap_1")}`);
    expect(res.headers.get("location")).toBe("https://getchairback.com/dashboard/booking?appointment=ap_1");
    expect(res.headers.get("set-cookie")).toContain("tok");
  });

  it("without a next, or with a bad one, still lands on /dashboard", async () => {
    expect((await get("")).headers.get("location")).toBe("https://getchairback.com/dashboard");
    expect((await get("?next=https%3A%2F%2Fevil.example")).headers.get("location")).toBe(
      "https://getchairback.com/dashboard",
    );
  });
});
