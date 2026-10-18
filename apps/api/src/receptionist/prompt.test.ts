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
  firstBarber: "Drick",
  otherBarberOffer: " or Moe has spots this week?",
  address: "n/a",
  timezone: "America/New_York",
  hours: "Mon 9:00 AM-6:00 PM",
  serviceMenu: "Cut - $35 (30 min)",
  bookingUrl: "https://x.test/book/fade-lab",
  depositPolicy: "none - pay at the shop",
  cancellationPolicy: "free cancellation any time before the appointment",
  reschedulePolicy: "clients can move it themselves up to 24 hours before; after that only the shop can move it",
  clientCancelPolicy: "clients can cancel it themselves any time before the appointment",
  noShowPolicy: "no charge for a no-show",
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
      "cancel {{CANCELLATION_POLICY}} vibe {{TONE}} first {{FIRST_BARBER}}{{OTHER_BARBER_OFFER}} at {{ADDRESS}} noshow {{NO_SHOW_POLICY}}";
    const out = renderTemplate(template, FIXTURE);
    expect(out).not.toMatch(/\{\{(SHOP_NAME|BARBER_NAMES|TIMEZONE|HOURS|SERVICE_MENU|BOOKING_URL|DEPOSIT_POLICY|CANCELLATION_POLICY|NO_SHOW_POLICY|TONE|FIRST_BARBER|OTHER_BARBER_OFFER|ADDRESS)\}\}/);
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
    // 🔴 THIS SHOP CANNOT CHARGE THE FEE IT HAS CONFIGURED. paymentsMode is
    // left at its default (off), so no card is ever taken and
    // cancelAppointment computes the fee from an amount that does not exist.
    // The prompt used to quote "50% of the price is kept as a fee" anyway -
    // a threat the system cannot carry out, told to a customer over SMS.
    expect(text).toContain("free cancellation any time before the appointment");
    expect(text).not.toContain("50%");
    // Nothing is collected here either: this conversation books, it never
    // charges, and its own booking tool writes no Payment row.
    expect(text).toContain("none - pay at the shop");
    expect(text).toContain("relaxed & friendly");
    // The shop's reschedule cutoff (the 24-hour default), in the same words
    // the reschedule tool refuses with - so it can say so before it tries.
    expect(text).toContain(
      "Rescheduling:     clients can move it themselves up to 24 hours before; after that only the shop can move it",
    );
    // Whether the client may cancel by text at all (default: yes, until the
    // start) - the rule the cancel tool enforces (config/customerChangeRules.ts).
    expect(text).toContain(
      "Client cancels:   clients can cancel it themselves any time before the appointment",
    );
    // Every config placeholder got filled.
    expect(text).not.toMatch(/\{\{(SHOP_NAME|BARBER_NAMES|TIMEZONE|HOURS|SERVICE_MENU|BOOKING_URL|DEPOSIT_POLICY|CANCELLATION_POLICY|RESCHEDULE_POLICY|CLIENT_CANCEL_POLICY|NO_SHOW_POLICY|TONE|FIRST_BARBER|OTHER_BARBER_OFFER|ADDRESS)\}\}/);

    // A shop that takes no changes from clients says so up front, so the
    // receptionist doesn't promise what its tools will refuse.
    await prisma.shop.update({
      where: { id: shop.id },
      data: { customerCanReschedule: false, customerCanCancel: true, cancelCutoffHours: 12 },
    });
    const strict = (await renderPromptForShop(shop.id))!;
    expect(strict).toContain(
      "Rescheduling:     clients can't move an appointment themselves (online or by text) - only the shop can",
    );
    expect(strict).toContain(
      "Client cancels:   clients can cancel it themselves up to 12 hours before; after that only the shop can",
    );
  });

  it("🔴 a card-on-file shop with fees ON: the receptionist never says 'free cancellation' for a card it will charge", async () => {
    // services/cardOnFileSettle.ts charges a kept card for a late cancel. The
    // prompt said "free cancellation any time" because nothing is COLLECTED in
    // this mode - while the client who booked online with a card was charged.
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
    __resetEnvCacheForTests();
    try {
      const shop = await prisma.shop.create({
        data: {
          ownerId: userId,
          name: "Card Cuts",
          slug: `card-${randomToken(5)}`,
          webhookSecret: randomToken(),
          bookingMode: "native",
          timezone: "America/Chicago",
          paymentsMode: "card_on_file",
          chargeCardOnFileFees: true,
          cancelWindowHours: 24,
          cancelFeeBps: 5000,
          connectChargesEnabled: true,
          stripeConnectAccountId: `acct_${randomToken(6)}`,
        },
        select: { id: true },
      });
      const text = (await renderPromptForShop(shop.id))!;
      expect(text).not.toContain("free cancellation any time before the appointment");
      expect(text).toContain("charged 50% of the booked price for a cancellation inside 24h of the start");
      // A booking made by text keeps no card, so it IS free - and that is said too.
      expect(text).toContain("free cancellation any time for a booking made in this conversation");

      // Fees OFF: the card is never charged, and the prompt says free.
      await prisma.shop.update({ where: { id: shop.id }, data: { chargeCardOnFileFees: false } });
      const off = (await renderPromptForShop(shop.id))!;
      expect(off).toContain("free cancellation any time before the appointment");
      expect(off).not.toContain("50%");

      // A FLAT fee: the receptionist quotes the amount, from the same words.
      await prisma.shop.update({
        where: { id: shop.id },
        data: { chargeCardOnFileFees: true, cardFeeFlatCents: 2500 },
      });
      const flat = (await renderPromptForShop(shop.id))!;
      expect(flat).toContain("charged $25 (or the booked price, if less) for a cancellation inside 24h of the start");
      expect(flat).not.toContain("50%");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
      __resetEnvCacheForTests();
    }
  });

  it("🔴 an Acuity-booking shop's receptionist sends its Acuity link, never a ChairBack page that refuses it", async () => {
    const shop = await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Acuity Cuts",
        slug: `acuity-${randomToken(5)}`,
        webhookSecret: randomToken(),
        bookingMode: "acuity",
        bookingUrl: "https://acuitycuts.as.me/schedule",
        timezone: "America/Chicago",
      },
      select: { id: true, slug: true },
    });
    const text = (await renderPromptForShop(shop.id))!;
    expect(text).toContain("https://acuitycuts.as.me/schedule");
    expect(text).not.toContain(`/book/${shop.slug}`);
  });
});
