import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { ingestAppointment } from "../ingest.js";
import { emailAddressKey } from "../engines/broadcastAudience.js";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * 🔴 A YES TO MARKETING EMAIL IS FOR ONE ADDRESS.
 *
 * A database trigger (migration 20261029000000_email_yes_follows_address)
 * clears a record's yes when its email changes to a different address, by any
 * path - so a yes given for one inbox can never switch on mail to another.
 * What counts as "different" is what emailAddressKey compares; a statement
 * that records a yes itself keeps it; an unsubscribe and a bounce are never
 * touched.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie = "";
let shopId = "";

const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const YES = { emailMarketingConsentAt: EARLIER, emailMarketingConsentSource: "booking_page" };

beforeAll(async () => {
  const email = `yes-address-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Marcus Reed Studio", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

/** A fresh made-up phone per record (555-01xx), keyed as the Acuity sync keys it. */
let seq = 0;
function newPhone() {
  seq += 1;
  return `+1302555${String(100 + seq).padStart(4, "0")}`;
}

async function client(data: {
  phone?: string;
  email: string | null;
  emailMarketingConsentAt?: Date | null;
  emailMarketingConsentSource?: string | null;
  emailOptedOut?: boolean;
  emailOptedOutAt?: Date | null;
  emailSuppressedAt?: Date | null;
  emailSuppressionReason?: string | null;
}) {
  const phone = data.phone ?? newPhone();
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${phone}`,
      magicToken: randomToken(),
      firstName: "Marcus",
      lastName: "Reed",
      ...data,
      phone,
    },
    select: { id: true, phone: true },
  });
}

const row = (id: string) => prisma.client.findUniqueOrThrow({ where: { id } });

let apptSeq = 9100;
/** The Acuity sync, exactly as a webhook drives it: the raw address Acuity holds. */
async function sync(phone: string, email: string) {
  apptSeq += 1;
  const start = new Date(Date.now() - 5 * 86_400_000);
  start.setUTCHours(15, 0, 0, 0);
  const appt: AcuityAppointment = {
    id: String(apptSeq),
    firstName: "Marcus",
    lastName: "Reed",
    phone,
    email,
    datetime: start.toISOString(),
    endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
    price: "30.00",
    type: "Cut",
    canceled: false,
    noShow: false,
    duration: 30,
  };
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  await ingestAppointment(shop, "scheduled", appt.id, appt);
}

describe("a different address clears the yes", () => {
  it("🔴 a hand edit to a new address", async () => {
    const c = await client({ email: "marcus@example.com", ...YES });
    const res = await request(app)
      .patch(`/api/dashboard/clients/${c.id}`)
      .set("Cookie", cookie)
      .send({ email: "marcus.new@example.com" });
    expect(res.status).toBe(200);
    const after = await row(c.id);
    expect(after.email).toBe("marcus.new@example.com");
    expect(after.emailMarketingConsentAt).toBeNull();
    expect(after.emailMarketingConsentSource).toBeNull();
  });

  it("🔴 a sync with a new address - and the unsubscribe and bounce are kept", async () => {
    const bounced = new Date("2026-02-01T00:00:00.000Z");
    const c = await client({
      email: "old@example.com",
      ...YES,
      emailOptedOut: true,
      emailOptedOutAt: EARLIER,
      emailSuppressedAt: bounced,
      emailSuppressionReason: "hard_bounce",
    });
    await sync(c.phone!, "new@example.com");
    const after = await row(c.id);
    expect(after.email).toBe("new@example.com");
    expect(after.emailMarketingConsentAt).toBeNull();
    expect(after.emailMarketingConsentSource).toBeNull();
    // Their decision survives every email change.
    expect(after.emailOptedOut).toBe(true);
    expect(after.emailOptedOutAt).toEqual(EARLIER);
    expect(after.emailSuppressedAt).toEqual(bounced);
    expect(after.emailSuppressionReason).toBe("hard_bounce");
  });

  it("the address removed", async () => {
    const c = await client({ email: "gone@example.com", ...YES });
    await prisma.client.update({ where: { id: c.id }, data: { email: null } });
    expect((await row(c.id)).emailMarketingConsentAt).toBeNull();
  });

  it("a blank record getting an address - there was no address to have said yes for", async () => {
    const c = await client({ email: null, ...YES });
    await prisma.client.update({ where: { id: c.id }, data: { email: "arrived@example.com" } });
    const after = await row(c.id);
    expect(after.emailMarketingConsentAt).toBeNull();
    expect(after.emailMarketingConsentSource).toBeNull();
  });

  it("accepted: a change of case in a NON-ASCII letter reads as a new address and clears it", async () => {
    // The trigger lower-cases A-Z only (no locale, no ICU), so it errs toward
    // clearing: JOSÉ@ and josé@ are one address to emailAddressKey, two here.
    const c = await client({ email: "JOSÉ@example.com", ...YES });
    await prisma.client.update({ where: { id: c.id }, data: { email: "josé@example.com" } });
    expect((await row(c.id)).emailMarketingConsentAt).toBeNull();
  });
});

describe("the same address keeps the yes", () => {
  it("🔴 only a change of case or spacing, from a sync", async () => {
    const c = await client({ email: "marcus.reed@example.com", ...YES });
    await sync(c.phone!, "  Marcus.Reed@EXAMPLE.com ");
    const after = await row(c.id);
    // The raw text did change - the address did not.
    expect(after.email).toBe("  Marcus.Reed@EXAMPLE.com ");
    expect(after.emailMarketingConsentAt).toEqual(EARLIER);
    expect(after.emailMarketingConsentSource).toBe("booking_page");
  });

  it("every whitespace character JavaScript's trim() removes", async () => {
    const c = await client({ email: "ws@example.com", ...YES });
    await prisma.client.update({
      where: { id: c.id },
      data: { email: "\t 　﻿WS@Example.com \n\r" },
    });
    expect((await row(c.id)).emailMarketingConsentAt).toEqual(EARLIER);
  });

  it("an update that does not touch the email", async () => {
    const c = await client({ email: "stay@example.com", ...YES });
    await prisma.client.update({ where: { id: c.id }, data: { firstName: "Marc" } });
    expect((await row(c.id)).emailMarketingConsentAt).toEqual(EARLIER);
  });
});

describe("a statement that records a yes itself", () => {
  it("🔴 one update setting a new address AND a yes keeps the yes", async () => {
    const c = await client({ email: null });
    const now = new Date("2026-09-28T12:00:00.000Z");
    await prisma.client.update({
      where: { id: c.id },
      data: {
        email: "both@example.com",
        emailMarketingConsentAt: now,
        emailMarketingConsentSource: "customer_settings",
      },
    });
    const after = await row(c.id);
    expect(after.emailMarketingConsentAt).toEqual(now);
    expect(after.emailMarketingConsentSource).toBe("customer_settings");
  });

  it("🔴 the booking page's tick for a brand-new client still lands", async () => {
    // The booking page's own write, statement for statement: upsert the
    // client with the typed address, then stamp the yes first-wins.
    const phone = newPhone();
    const now = new Date();
    const id = await prisma.$transaction(async (tx) => {
      const c = await tx.client.upsert({
        where: { shopId_acuityClientKey: { shopId, acuityClientKey: `tel:${phone}` } },
        create: {
          shopId,
          acuityClientKey: `tel:${phone}`,
          magicToken: randomToken(),
          firstName: "Marcus",
          lastName: "Reed",
          phone,
          email: "brand.new@example.com",
          source: "manual",
        },
        update: { firstName: "Marcus", lastName: "Reed", phone, email: "brand.new@example.com" },
        select: { id: true },
      });
      await tx.client.updateMany({
        where: { id: c.id, emailMarketingConsentAt: null },
        data: { emailMarketingConsentAt: now, emailMarketingConsentSource: "booking_page" },
      });
      return c.id;
    });
    const after = await row(id);
    expect(after.emailMarketingConsentAt).toEqual(now);
    expect(after.emailMarketingConsentSource).toBe("booking_page");
  });

  it("a returning client's booking with the same address typed differently keeps an earlier yes", async () => {
    const c = await client({ email: "back@example.com", ...YES });
    // The booking upsert's update half writes the typed (trimmed) address.
    await prisma.client.update({ where: { id: c.id }, data: { email: "Back@Example.com" } });
    expect((await row(c.id)).emailMarketingConsentAt).toEqual(EARLIER);
  });
});

describe("the database's address key and emailAddressKey", () => {
  const key = async (email: string | null) =>
    (await prisma.$queryRaw<{ k: string | null }[]>`SELECT client_email_address_key(${email}) AS k`)[0]!.k;

  it("agree exactly on ASCII addresses, blanks, and every whitespace trim() removes", async () => {
    const js = [
      "\t", "\n", "\u000b", "\f", "\r", " ", " ", " ", " ", " ", " ",
      " ", " ", " ", " ", " ", " ", " ", " ", " ",
      " ", " ", " ", "　", "﻿",
    ];
    // The set really is what trim() removes - so this list cannot drift from it.
    for (const w of js) expect(w.trim()).toBe("");
    const inputs: (string | null)[] = [
      null,
      "",
      "   ",
      "marcus@example.com",
      "  MARCUS.Reed+Cuts@Example.COM  ",
      "a.b-c_d'e@sub.example.co.uk",
      ...js.map((w) => `${w}Reed@Example.com${w}`),
      // NOT trimmed by JavaScript, so not by the database either.
      "​Reed@example.com",
      "\u0085Reed@example.com",
      "᠎Reed@example.com",
    ];
    for (const input of inputs) {
      expect(await key(input), JSON.stringify(input)).toBe(emailAddressKey(input));
    }
  });

  it("🔴 never calls two addresses the same when emailAddressKey calls them different", async () => {
    const letters = ["JOSÉ@example.com", "josé@example.com", "İ@example.com", "i@example.com", "i̇@example.com",
      "ΟΔΟΣ@example.com", "οδοσ@example.com", "οδος@example.com", "ẞ@example.com", "ß@example.com"];
    for (const a of letters) {
      for (const b of letters) {
        if ((await key(a)) === (await key(b))) {
          expect(emailAddressKey(a), `${a} vs ${b}`).toBe(emailAddressKey(b));
        }
      }
    }
  });
});
