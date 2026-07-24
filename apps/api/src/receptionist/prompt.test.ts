import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  __resetPromptCacheForTests,
  loadPromptTemplate,
  renderPromptForShop,
  renderTemplate,
  type ShopPromptConfig,
} from "./prompt.js";

/**
 * The receptionist system prompt is LOADED AT RUNTIME from
 * ai/receptionist-prompt.md and config-injected per shop - the persona is never
 * inlined in code. These tests cover the loader (walk-up path resolution,
 * missing-file feature-off) and the {{PLACEHOLDER}} rendering from real shop
 * rows.
 */

const FIXTURE: ShopPromptConfig = {
  shopName: "Fade Lab",
  barberNames: "Drick, Moe",
  otherBarber: "Moe",
  address: "n/a",
  timezone: "America/New_York",
  hours: "Mon 9:00 AM-6:00 PM",
  serviceMenu: "Cut - $35 (30 min)",
  bookingUrl: "https://x.test/book/fade-lab",
  depositPolicy: "none - pay at the shop",
  cancellationPolicy: "free cancellation any time before the appointment",
  tone: "sharp & no-nonsense",
};

let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `prompt-${randomToken(6)}@test.chairback`,
      name: "Prompt Tester",
    },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(async () => {
  delete process.env.RECEPTIONIST_PROMPT_PATH;
  __resetEnvCacheForTests();
  __resetPromptCacheForTests();
});

describe("renderTemplate", () => {
  it("fills every known placeholder", () => {
    const template =
      "Shop {{SHOP_NAME}} run by {{BARBER_NAMES}} ({{TIMEZONE}}), hours {{HOURS}}.\n" +
      "{{SERVICE_MENU}}\nBook: {{BOOKING_URL}} deposit {{DEPOSIT_POLICY}} " +
      "cancel {{CANCELLATION_POLICY}} vibe {{TONE}} other {{OTHER_BARBER}} at {{ADDRESS}}";
    const out = renderTemplate(template, FIXTURE);
    expect(out).not.toMatch(/\{\{(SHOP_NAME|BARBER_NAMES|TIMEZONE|HOURS|SERVICE_MENU|BOOKING_URL|DEPOSIT_POLICY|CANCELLATION_POLICY|TONE|OTHER_BARBER|ADDRESS)\}\}/);
    expect(out).toContain("Fade Lab");
    expect(out).toContain("Drick, Moe");
    expect(out).toContain("Cut - $35 (30 min)");
    expect(out).toContain("sharp & no-nonsense");
  });

  it("leaves unknown tokens visible instead of guessing", () => {
    const out = renderTemplate("keep {{DOUBLE_BRACES}} as-is", FIXTURE);
    expect(out).toBe("keep {{DOUBLE_BRACES}} as-is");
  });
});

describe("loadPromptTemplate", () => {
  it("finds the real repo prompt file via walk-up and caches it", () => {
    __resetPromptCacheForTests();
    const text = loadPromptTemplate();
    expect(text).toBeTruthy();
    expect(text).toContain("{{SHOP_NAME}}");
    expect(text).toContain("check_availability");
    // Second read hits the mtime cache (same content back).
    expect(loadPromptTemplate()).toBe(text);
  });

  it("returns null (feature-off) when the file is missing - never throws", () => {
    process.env.RECEPTIONIST_PROMPT_PATH = "C:/definitely/not/a/real/prompt.md";
    __resetEnvCacheForTests();
    __resetPromptCacheForTests();
    expect(loadPromptTemplate()).toBeNull();
    delete process.env.RECEPTIONIST_PROMPT_PATH;
    __resetEnvCacheForTests();
    __resetPromptCacheForTests();
  });
});

describe("renderPromptForShop", () => {
  it("renders real shop config: staff, menu with add-ons, weekly hours, policies", async () => {
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Prompt Cuts",
        slug: `prompt-${randomToken(5)}`,
        webhookSecret: randomToken(),
        bookingMode: "native",
        timezone: "America/Chicago",
        receptionistTone: "relaxed & friendly",
        cancelWindowHours: 12,
        cancelFeeBps: 5000,
      },
      select: { id: true, slug: true },
    });
    const staff = await prisma.staff.create({
      data: { shopId: shop.id, name: "Drick" },
    });
    await prisma.staff.create({
      data: { shopId: shop.id, name: "Zeke", active: false }, // inactive: excluded
    });
    const service = await prisma.service.create({
      data: { shopId: shop.id, name: "Skin Fade", durationMin: 40, price: 40 },
    });
    await prisma.serviceAddOn.create({
      data: { shopId: shop.id, serviceIds: [service.id], name: "Hot Towel", durationMin: 10, price: 8 },
    });
    await prisma.serviceAddOn.create({
      data: { shopId: shop.id, serviceIds: [], name: "Beard Lineup", durationMin: 15, price: 12 },
    });
    // Tue + Sat hours.
    await prisma.availabilityRule.create({
      data: { shopId: shop.id, staffId: staff.id, weekday: 2, startMin: 540, endMin: 1080 },
    });
    await prisma.availabilityRule.create({
      data: { shopId: shop.id, staffId: staff.id, weekday: 6, startMin: 600, endMin: 960 },
    });

    const out = await renderPromptForShop(shop.id);
    expect(out).toBeTruthy();
    const text = out!;
    expect(text).toContain("Prompt Cuts");
    expect(text).toContain("Drick");
    expect(text).not.toContain("Zeke");
    expect(text).toContain("America/Chicago");
    expect(text).toContain("Skin Fade - $40 (40 min)");
    expect(text).toContain("Hot Towel");
    expect(text).toContain("Beard Lineup");
    expect(text).toContain("Tue 9:00 AM-6:00 PM");
    expect(text).toContain("Sat 10:00 AM-4:00 PM");
    expect(text).toContain(`/book/${shop.slug}`);
    expect(text).toContain("free up to 12h before");
    expect(text).toContain("50% of the price");
    expect(text).toContain("relaxed & friendly");
    // Every config placeholder got filled.
    expect(text).not.toMatch(/\{\{(SHOP_NAME|BARBER_NAMES|TIMEZONE|HOURS|SERVICE_MENU|BOOKING_URL|DEPOSIT_POLICY|CANCELLATION_POLICY|TONE)\}\}/);
  });
});
