import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { smsEnabled } from "../messaging/twilio.js";
import {
  __resetPlatformSwitchesForTests,
  refreshPlatformSwitches,
} from "../services/platformSwitches.js";

/**
 * THE TEXTING SWITCH IN THE ADMIN PORTAL. Texts cost money; the founder turns
 * them on and off from the admin page, and it takes effect without a deploy.
 *
 *  - only an admin session can read or flip it (404 for anyone else, like the
 *    rest of the portal);
 *  - a flip takes effect in THIS process at once, and another process follows
 *    on its next refresh;
 *  - until anyone has used it, the SMS_ENABLED default applies;
 *  - a failed refresh keeps the last value: a database blip must never be what
 *    switches texting on (a bill) or off (silence).
 */
const app = createApp();
const adminEmail = `smsswitch-a-${randomToken(6)}@test.local`.toLowerCase();
const userEmail = `smsswitch-u-${randomToken(6)}@test.local`.toLowerCase();
let adminCookie: string;
let userCookie: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Switch", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

const clearSwitch = () =>
  runAsOwner((tx) => tx.platformSwitch.deleteMany({ where: { key: "sms" } }));

beforeAll(async () => {
  adminCookie = await signup(adminEmail);
  userCookie = await signup(userEmail);
  await prisma.user.update({ where: { email: adminEmail }, data: { isAdmin: true } });
  await clearSwitch();
  __resetPlatformSwitchesForTests();
});

afterEach(async () => {
  // Leave the platform as every other suite expects it: no row, env default.
  await clearSwitch();
  __resetPlatformSwitchesForTests();
  process.env.SMS_ENABLED = "true";
  __resetEnvCacheForTests();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
  await prisma.$disconnect();
});

describe("who can use it", () => {
  it("404s for a signed-in non-admin, on read and on flip", async () => {
    const read = await request(app).get("/api/admin-portal/switches/sms").set("Cookie", userCookie);
    expect(read.status).toBe(404);
    const flip = await request(app)
      .post("/api/admin-portal/switches/sms")
      .set("Cookie", userCookie)
      .send({ enabled: false });
    expect(flip.status).toBe(404);
    expect(await runAsOwner((tx) => tx.platformSwitch.count({ where: { key: "sms" } }))).toBe(0);
  });

  it("refuses anything but a boolean", async () => {
    const res = await request(app)
      .post("/api/admin-portal/switches/sms")
      .set("Cookie", adminCookie)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("flipping it", () => {
  it("before anyone has used it, the environment default is what the page shows", async () => {
    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await request(app).get("/api/admin-portal/switches/sms").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, source: "default", updatedAt: null, updatedByEmail: null });
  });

  it("🔴 off takes effect at once, and on again brings texting back - no deploy", async () => {
    expect(smsEnabled()).toBe(true); // the suites' default

    const off = await request(app)
      .post("/api/admin-portal/switches/sms")
      .set("Cookie", adminCookie)
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ ok: true, enabled: false });
    expect(smsEnabled()).toBe(false);

    const shown = await request(app).get("/api/admin-portal/switches/sms").set("Cookie", adminCookie);
    expect(shown.body).toMatchObject({ enabled: false, source: "admin", updatedByEmail: adminEmail });
    expect(typeof shown.body.updatedAt).toBe("string");

    const on = await request(app)
      .post("/api/admin-portal/switches/sms")
      .set("Cookie", adminCookie)
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(smsEnabled()).toBe(true);
  });

  it("the switch beats the environment default once it has been used", async () => {
    process.env.SMS_ENABLED = "false";
    __resetEnvCacheForTests();
    await request(app)
      .post("/api/admin-portal/switches/sms")
      .set("Cookie", adminCookie)
      .send({ enabled: true });
    expect(smsEnabled()).toBe(true);
  });
});

describe("another process following a flip", () => {
  it("picks the stored value up on refresh, and hands back to the default when the row goes", async () => {
    await runAsOwner((tx) =>
      tx.platformSwitch.create({ data: { key: "sms", enabled: false, updatedById: null } }),
    );
    // This process has not been told (as if the flip happened on a replica).
    expect(smsEnabled()).toBe(true);
    await refreshPlatformSwitches();
    expect(smsEnabled()).toBe(false);

    await clearSwitch();
    await refreshPlatformSwitches();
    expect(smsEnabled()).toBe(true); // env default again
  });

  it("🔴 a failed refresh keeps the last value instead of flipping texting", async () => {
    await runAsOwner((tx) =>
      tx.platformSwitch.create({ data: { key: "sms", enabled: false, updatedById: null } }),
    );
    await refreshPlatformSwitches();
    expect(smsEnabled()).toBe(false);

    const boom = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
    try {
      await refreshPlatformSwitches();
    } finally {
      boom.mockRestore();
    }
    expect(smsEnabled()).toBe(false);
  });
});

describe("the table is only ever read as the owner", () => {
  it("🔴 no code touches prisma.platformSwitch outside runAsOwner", () => {
    // FORCE RLS with no policy: in production a plain owner query returns
    // nothing and a write is refused. The local test DB is a superuser and
    // would never notice - so this is checked in the source instead.
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
          if (/\bprisma\.platformSwitch\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
