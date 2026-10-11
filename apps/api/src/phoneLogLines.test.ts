import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { maskPhone } from "./logRedaction.js";
import { NoopMessageProvider, SmsDisabledProvider } from "./messaging/twilio.js";

/**
 * 🔴 NO CUSTOMER PHONE NUMBER IN A LOG LINE.
 *
 * The STOP / START webhook and the dry-run and texting-off providers logged
 * the customer's number in full - on every keyword and every suppressed send -
 * into a stream that is forwarded on and outlives the customer's own opt-out.
 * Each is asserted against everything the logger was handed, not one field,
 * so a number moved to another key still fails.
 */

const app = createApp();
let ownerId: string;
let shopId: string;

/** Every argument every log call received, serialised. */
function everythingLogged(spies: ReturnType<typeof vi.spyOn>[]): string {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

function spyAll() {
  return [
    vi.spyOn(logger, "info"),
    vi.spyOn(logger, "warn"),
    vi.spyOn(logger, "error"),
  ] as ReturnType<typeof vi.spyOn>[];
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `phonelog-${randomToken(6)}@test.local`, passwordHash: "x", name: "PL" },
    select: { id: true },
  });
  ownerId = user.id;
  shopId = (
    await prisma.shop.create({
      data: { ownerId, name: "Phone Log Cuts", bookingUrl: "https://pl.test", webhookSecret: randomToken() },
      select: { id: true },
    })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

describe("maskPhone", () => {
  it("keeps the last two digits and nothing else", () => {
    expect(maskPhone("+13025550167")).toBe("***67");
    expect(maskPhone("(302) 555-0167")).toBe("***67");
    expect(maskPhone("7")).toBe("***");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone("")).toBeNull();
  });
});

describe("the Twilio webhook's STOP and START lines", () => {
  it.each(["STOP", "START"])("🔴 %s logs the outcome, not the number", async (keyword) => {
    const phone = `+1302555${Math.floor(1000 + Math.random() * 8999)}`;
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `pl-${randomToken(6)}`,
        magicToken: randomToken(),
        phone,
        optedOut: keyword === "START",
      },
    });
    const spies = spyAll();

    const res = await request(app)
      .post("/webhooks/twilio/inbound")
      .type("form")
      .send({ From: phone, Body: keyword });
    expect(res.status).toBe(200);

    const logged = everythingLogged(spies);
    // The keyword line was written (so this is not passing on silence)...
    expect(logged).toContain(keyword === "STOP" ? "twilio STOP - opted out" : "twilio START - opted in");
    // ...and nowhere in it is the number, in any spelling.
    expect(logged).not.toContain(phone);
    expect(logged).not.toContain(phone.slice(2));
    expect(logged).toContain(maskPhone(phone)!);
  });
});

describe("the providers that do not send", () => {
  const phone = "+13025550199";

  it("🔴 the dry-run provider logs a suppressed send without the number", async () => {
    const spies = spyAll();
    await new NoopMessageProvider().send({ to: phone, body: "hi" });
    const logged = everythingLogged(spies);
    expect(logged).toContain("[dry-run] suppressed SMS send");
    expect(logged).not.toContain(phone.slice(2));
  });

  it("🔴 the texting-off provider logs a refusal without the number", async () => {
    const spies = spyAll();
    await expect(new SmsDisabledProvider().send({ to: phone, body: "hi" })).rejects.toThrow();
    const logged = everythingLogged(spies);
    expect(logged).toContain("SMS send refused: texting is turned off");
    expect(logged).not.toContain(phone.slice(2));
  });
});
