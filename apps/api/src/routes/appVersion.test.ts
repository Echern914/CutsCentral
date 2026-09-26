import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { createApp } from "../app.js";
import { minimumBuildFrom } from "./appVersion.js";

/**
 * The app's "is this build too old?" check.
 *
 * The number is typed by hand into Railway at every release, so the parser is
 * the part worth pinning: every way of getting it wrong must land on "off",
 * because the alternative directions are "the API will not boot" and "every
 * customer is told to update".
 */

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/app-version", () => {
  it("answers without a session, and never from a cache", async () => {
    const res = await request(app).get("/api/app-version");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toHaveProperty("iosMinimumBuild");
  });

  it("is off while IOS_MINIMUM_BUILD is unset", async () => {
    // The test environment sets no minimum, which is also production's
    // starting state: merging this must not ask a single phone to update.
    const res = await request(app).get("/api/app-version");
    expect(res.body).toEqual({ iosMinimumBuild: null });
  });
});

describe("minimumBuildFrom - reading IOS_MINIMUM_BUILD", () => {
  it("a whole number is the minimum", () => {
    expect(minimumBuildFrom("49")).toEqual({ build: 49, invalid: false });
    expect(minimumBuildFrom(" 52 ")).toEqual({ build: 52, invalid: false });
  });

  it("unset, empty and 0 are off, and are not mistakes", () => {
    expect(minimumBuildFrom(undefined)).toEqual({ build: null, invalid: false });
    expect(minimumBuildFrom("")).toEqual({ build: null, invalid: false });
    expect(minimumBuildFrom("   ")).toEqual({ build: null, invalid: false });
    expect(minimumBuildFrom("0")).toEqual({ build: null, invalid: false });
  });

  it("anything else is off AND reported, never a boot failure", () => {
    for (const typo of ["49a", "1.1.4", "-1", "4 9", "forty-nine", "49.0", "1e3"]) {
      expect(minimumBuildFrom(typo)).toEqual({ build: null, invalid: true });
    }
  });

  it("a number too large to be exact is a mistake, not a lockout", () => {
    expect(minimumBuildFrom("99999999999999999999")).toEqual({ build: null, invalid: true });
  });
});
