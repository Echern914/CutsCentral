import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { unsubscribeDigestFor, unsubscribeTokenFor } from "../engines/unsubscribeToken.js";
import { splitAudience, suppressionAddressHash } from "../engines/broadcastAudience.js";
import { recordEmailMarketingYes } from "../services/emailMarketingConsent.js";
import { loadAddressSuppressions } from "../services/emailSuppression.js";

/**
 * MARKETING EMAIL NEEDS A RECORDED YES - and these are the only doors that
 * record one.
 *
 *  - The booking page: the customer's own unticked box. It lands only on the
 *    record that already held the address they typed (or a new one), never on
 *    a record found by a shared phone, and it never undoes an unsubscribe.
 *  - The rewards page: the customer's own on/off. On records the yes (and may
 *    lift their OWN unsubscribe); off is exactly the unsubscribe link.
 *  - The shop, for one client, saying how they said yes. Refused with no
 *    address and after an unsubscribe; the shop can take back only its own.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];
let cookie = "";
let shopId = "";
let slug = "";
let staffId = "";
let serviceId = "";
let otherShopClientId = "";
let slots: string[] = [];

const EARLIER = new Date("2026-01-01T00:00:00.000Z");

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(ownerCookie: string, name: string) {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name, bookingUrl: "https://optin.test", smsAttested: true });
  expect(res.status).toBe(201);
  shopIds.push(res.body.id as string);
  return res.body.id as string;
}

beforeAll(async () => {
  cookie = await signup("optin-owner");
  shopId = await makeShop(cookie, "Marcus Reed Cuts");
  const shop = await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 },
    select: { slug: true },
  });
  slug = shop.slug!;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 0,
      endMin: 1439,
    })),
  });
  // Open times two hours apart, so no two bookings below can collide.
  const res = await request(app).get(`/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`);
  expect(res.status).toBe(200);
  let last = -Infinity;
  for (const s of res.body.slots as { startsAt: string }[]) {
    const t = new Date(s.startsAt).getTime();
    if (t - last >= 2 * 3_600_000) {
      slots.push(s.startsAt);
      last = t;
    }
  }
  expect(slots.length).toBeGreaterThan(20);

  const otherCookie = await signup("optin-other");
  const otherShop = await makeShop(otherCookie, "Other Cuts");
  otherShopClientId = (
    await prisma.client.create({
      data: {
        shopId: otherShop,
        acuityClientKey: `mail:other-${randomToken(6)}@example.com`,
        magicToken: randomToken(),
        firstName: "Other",
        email: "other@example.com",
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

/** A fresh made-up phone per customer (555-01xx), so each test has its own record. */
let phoneSeq = 0;
function newPhone() {
  phoneSeq += 1;
  return `+1302555${String(100 + phoneSeq).padStart(4, "0")}`;
}

function book(body: { phone: string; email: string; emailMarketing?: boolean; recurrence?: object }) {
  const startsAt = slots.shift();
  expect(startsAt).toBeTruthy();
  return request(app)
    .post(`/api/book/${slug}`)
    .send({ staffId, serviceId, startsAt, firstName: "Marcus", lastName: "Reed", ...body });
}

/** A record already on the shop's books, keyed exactly as a booking with this phone finds it. */
async function existing(data: {
  phone: string;
  email: string | null;
  emailOptedOut?: boolean;
  emailMarketingConsentAt?: Date | null;
  emailMarketingConsentSource?: string | null;
}) {
  const acuityClientKey = deriveAcuityClientKey({ phone: data.phone });
  // The shared-phone cases below mean nothing unless the phone IS the key.
  expect(acuityClientKey.startsWith("tel:")).toBe(true);
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey,
      magicToken: randomToken(),
      firstName: "Dana",
      ...data,
      emailOptedOutAt: data.emailOptedOut ? EARLIER : null,
    },
    select: { id: true, magicToken: true },
  });
}

const byPhone = (phone: string) =>
  prisma.client.findFirstOrThrow({ where: { shopId, phone } });

const YES_EARLIER = { emailMarketingConsentAt: EARLIER, emailMarketingConsentSource: "booking_page" };

/** This shop's address-bound suppressions for one address (#514). */
const suppressions = (address: string) =>
  prisma.emailAddressSuppression.findMany({
    where: { shopId, addressHash: suppressionAddressHash(shopId, address)! },
    select: { kind: true, source: true },
    orderBy: { kind: "asc" },
  });

/** Who of these records an email broadcast would reach now - the real split, with the shop's suppressions. */
async function audienceOf(ids: string[]) {
  const [clients, suppressed] = await Promise.all([
    prisma.client.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        email: true,
        emailOptedOut: true,
        loyaltyTier: true,
        archivedAt: true,
        bookingBlockedAt: true,
        emailMarketingConsentAt: true,
      },
    }),
    runWithShop(shopId, (tx) => loadAddressSuppressions(tx, shopId)),
  ]);
  const split = splitAudience(
    clients.map((c) => ({ ...c, pushDevices: 0 })),
    "email",
    [],
    suppressed,
  );
  return {
    reachable: split.reachable.map((c) => c.id),
    skipped: split.skipped.map((s) => ({ id: s.client.id, reason: s.reason })),
  };
}

describe("the booking page: the customer's own unticked box", () => {
  it("a new customer who ticks it has a dated yes from the booking page", async () => {
    const phone = newPhone();
    const before = Date.now();
    const res = await book({ phone, email: "marcus.reed@example.com", emailMarketing: true });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailMarketingConsentSource).toBe("booking_page");
    expect(c.emailMarketingConsentAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("unticked records nothing", async () => {
    const phone = newPhone();
    const res = await book({ phone, email: "unticked@example.com" });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailMarketingConsentAt).toBeNull();
    expect(c.emailMarketingConsentSource).toBeNull();
  });

  it("a returning customer's yes lands when their record holds the address they typed", async () => {
    const phone = newPhone();
    await existing({ phone, email: "returning@example.com" });
    // Typed differently - the same inbox as emailAddressKey compares it.
    const res = await book({ phone, email: "  Returning@Example.com ", emailMarketing: true });
    expect(res.status).toBe(201);
    expect((await byPhone(phone)).emailMarketingConsentSource).toBe("booking_page");
  });

  it("🔴 a shared phone whose record held a DIFFERENT address gets no yes", async () => {
    // Dana's record; her son books on the family phone with his own address.
    const phone = newPhone();
    await existing({ phone, email: "dana@example.com" });
    const res = await book({ phone, email: "son@example.com", emailMarketing: true });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailMarketingConsentAt).toBeNull();
    expect(c.emailMarketingConsentSource).toBeNull();
  });

  it("🔴 a shared phone whose record held NO address gets no yes either", async () => {
    const phone = newPhone();
    await existing({ phone, email: null });
    const res = await book({ phone, email: "someone@example.com", emailMarketing: true });
    expect(res.status).toBe(201);
    expect((await byPhone(phone)).emailMarketingConsentAt).toBeNull();
  });

  it("unticked never clears an earlier yes", async () => {
    const phone = newPhone();
    await existing({
      phone,
      email: "kept@example.com",
      emailMarketingConsentAt: EARLIER,
      emailMarketingConsentSource: "customer_settings",
    });
    const res = await book({ phone, email: "kept@example.com", emailMarketing: false });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailMarketingConsentAt).toEqual(EARLIER);
    expect(c.emailMarketingConsentSource).toBe("customer_settings");
  });

  it("a second tick keeps the first yes (first wins)", async () => {
    const phone = newPhone();
    await existing({
      phone,
      email: "first@example.com",
      emailMarketingConsentAt: EARLIER,
      emailMarketingConsentSource: "staff:in_person",
    });
    const res = await book({ phone, email: "first@example.com", emailMarketing: true });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailMarketingConsentAt).toEqual(EARLIER);
    expect(c.emailMarketingConsentSource).toBe("staff:in_person");
  });

  it("🔴 a tick never undoes an unsubscribe - anyone can type anyone's address here", async () => {
    const phone = newPhone();
    await existing({ phone, email: "gone@example.com", emailOptedOut: true });
    const res = await book({ phone, email: "gone@example.com", emailMarketing: true });
    expect(res.status).toBe(201);
    const c = await byPhone(phone);
    expect(c.emailOptedOut).toBe(true);
    expect(c.emailOptedOutAt).toEqual(EARLIER);
    expect(c.emailMarketingConsentAt).toBeNull();
  });

  it("a standing appointment records the tick too", async () => {
    const phone = newPhone();
    const res = await book({
      phone,
      email: "standing@example.com",
      emailMarketing: true,
      recurrence: { interval: 1, count: 2 },
    });
    expect(res.status).toBe(201);
    expect((await byPhone(phone)).emailMarketingConsentSource).toBe("booking_page");
  });

  it("a standing appointment on a shared phone with a different address gets no yes", async () => {
    const phone = newPhone();
    await existing({ phone, email: "dana2@example.com" });
    const res = await book({
      phone,
      email: "son2@example.com",
      emailMarketing: true,
      recurrence: { interval: 1, count: 2 },
    });
    expect(res.status).toBe(201);
    expect((await byPhone(phone)).emailMarketingConsentAt).toBeNull();
  });
});

describe("the one write", () => {
  it("🔴 refuses a yes for an address the record does not hold", async () => {
    const c = await existing({ phone: newPhone(), email: "holder@example.com" });
    const result = await recordEmailMarketingYes(prisma, {
      clientId: c.id,
      address: "someone.else@example.com",
      source: "booking_page",
    });
    expect(result).toBe("different_address");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).emailMarketingConsentAt).toBeNull();
  });
});

describe("the rewards page: the customer's own on/off", () => {
  const view = async (token: string) => {
    const res = await request(app).get(`/api/rewards/${token}`);
    expect(res.status).toBe(200);
    return res.body.emailMarketing;
  };

  it("shows where they stand, and whether there is an address to say yes for", async () => {
    const a = await existing({ phone: newPhone(), email: "view@example.com" });
    expect(await view(a.magicToken)).toEqual({ state: "needs_consent", hasEmail: true });
    const b = await existing({ phone: newPhone(), email: null });
    expect(await view(b.magicToken)).toEqual({ state: "needs_consent", hasEmail: false });
  });

  it("On records a dated yes from their own settings", async () => {
    const c = await existing({ phone: newPhone(), email: "on@example.com" });
    const res = await request(app).post(`/api/rewards/${c.magicToken}/email-opt-in`).send({});
    expect(res.status).toBe(200);
    expect(res.body.emailMarketing).toEqual({ state: "opted_in", hasEmail: true });
    const row = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.emailMarketingConsentSource).toBe("customer_settings");
    expect(row.emailMarketingConsentAt).not.toBeNull();
    expect(await view(c.magicToken)).toEqual({ state: "opted_in", hasEmail: true });
  });

  it("🔴 On refuses after an unsubscribe - the shop can open this page - and says how to get them back", async () => {
    const c = await existing({
      phone: newPhone(),
      email: "back@example.com",
      emailOptedOut: true,
      emailMarketingConsentAt: EARLIER,
      emailMarketingConsentSource: "booking_page",
    });
    const res = await request(app).post(`/api/rewards/${c.magicToken}/email-opt-in`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unsubscribed");
    expect(res.body.message).toMatch(/Unsubscribe link .* press Resubscribe/);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.emailOptedOut).toBe(true);
    expect(row.emailOptedOutAt).toEqual(EARLIER);
    expect(row.emailMarketingConsentAt).toEqual(EARLIER);
    expect(row.emailMarketingConsentSource).toBe("booking_page");
  });

  it("On with no address on file is refused and writes nothing", async () => {
    const c = await existing({ phone: newPhone(), email: null });
    const res = await request(app).post(`/api/rewards/${c.magicToken}/email-opt-in`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("needs_email");
    const row = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.emailMarketingConsentAt).toBeNull();
  });

  it("🔴 Off has exactly the unsubscribe link's effect", async () => {
    const yes = { emailMarketingConsentAt: EARLIER, emailMarketingConsentSource: "booking_page" };
    const byLink = await existing({ phone: newPhone(), email: "link@example.com", ...yes });
    const bySwitch = await existing({ phone: newPhone(), email: "switch@example.com", ...yes });
    const fields = {
      emailOptedOut: true,
      emailOptedOutAt: true,
      emailMarketingConsentAt: true,
      emailMarketingConsentSource: true,
      optedOut: true,
      smsConsentAt: true,
      email: true,
    } as const;
    const before = await prisma.client.findUniqueOrThrow({ where: { id: bySwitch.id }, select: fields });

    // The footer link, as a sent broadcast offers it.
    await prisma.client.update({
      where: { id: byLink.id },
      data: { unsubscribeTokenHash: unsubscribeDigestFor(byLink.id) },
    });
    expect((await request(app).get(`/api/unsubscribe/${unsubscribeTokenFor(byLink.id)}`)).status).toBe(200);
    // The switch on their own page.
    const res = await request(app).post(`/api/rewards/${bySwitch.magicToken}/email-opt-out`).send({});
    expect(res.status).toBe(200);
    expect(res.body.emailMarketing).toEqual({ state: "opted_out", hasEmail: true });

    const a = await prisma.client.findUniqueOrThrow({ where: { id: byLink.id }, select: fields });
    const b = await prisma.client.findUniqueOrThrow({ where: { id: bySwitch.id }, select: fields });
    const shape = (r: typeof a) => ({ ...r, email: "-", emailOptedOutAt: r.emailOptedOutAt !== null });
    expect(shape(b)).toEqual(shape(a));
    // Out, dated, and the record of their earlier yes kept - nothing else moved.
    expect(b).toMatchObject({ emailOptedOut: true, emailMarketingConsentAt: EARLIER });
    expect({ ...b, emailOptedOut: false, emailOptedOutAt: null }).toEqual(before);
    expect(await view(bySwitch.magicToken)).toEqual({ state: "opted_out", hasEmail: true });
    // And both put the address on the shop's unsubscribed list, each saying where from.
    expect(await suppressions("link@example.com")).toEqual([{ kind: "unsubscribe", source: "unsubscribe_link" }]);
    expect(await suppressions("switch@example.com")).toEqual([{ kind: "unsubscribe", source: "customer_settings" }]);
  });

  it("🔴 Off writes the address suppression - so the address stays out on every record", async () => {
    const c = await existing({ phone: newPhone(), email: "Off.Switch@Example.com", ...YES_EARLIER });
    const twin = await existing({ phone: newPhone(), email: "off.switch@example.com", ...YES_EARLIER });
    const res = await request(app).post(`/api/rewards/${c.magicToken}/email-opt-out`).send({});
    expect(res.status).toBe(200);
    expect(await suppressions("off.switch@example.com")).toEqual([{ kind: "unsubscribe", source: "customer_settings" }]);
    // A second record holding the same address is left out too, though its own flag is unset.
    const split = await audienceOf([twin.id]);
    expect(split.reachable).toEqual([]);
    expect(split.skipped).toEqual([{ id: twin.id, reason: "unsubscribed" }]);
  });

  it("Off twice keeps the first date, as the link does", async () => {
    const c = await existing({ phone: newPhone(), email: "twice@example.com", emailOptedOut: true });
    const res = await request(app).post(`/api/rewards/${c.magicToken}/email-opt-out`).send({});
    expect(res.status).toBe(200);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.emailOptedOutAt).toEqual(EARLIER);
  });

  it("an unknown link is a plain 404 for both", async () => {
    expect((await request(app).post(`/api/rewards/nope-${randomToken(8)}/email-opt-in`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/rewards/nope-${randomToken(8)}/email-opt-out`).send({})).status).toBe(404);
  });
});

describe("the Resubscribe button - the only way back after an unsubscribe", () => {
  /** A record that got a broadcast (so its unsubscribe link works) and used it. */
  async function unsubscribedByLink(email: string) {
    const c = await existing({ phone: newPhone(), email, ...YES_EARLIER });
    await prisma.client.update({ where: { id: c.id }, data: { unsubscribeTokenHash: unsubscribeDigestFor(c.id) } });
    const token = unsubscribeTokenFor(c.id);
    const page = await request(app).get(`/api/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    return { ...c, token, page: page.text };
  }
  const resubscribe = (token: string) => request(app).post(`/api/unsubscribe/${token}/resubscribe`);

  it("the unsubscribe page offers it as a button that POSTs - never a link", async () => {
    const c = await unsubscribedByLink("button@example.com");
    expect(c.page).toContain(`<form method="post" action="/api/unsubscribe/${encodeURIComponent(c.token)}/resubscribe"`);
    expect(c.page).toMatch(/<button type="submit"[^>]*>Resubscribe<\/button>/);
    expect(c.page).not.toMatch(/<a [^>]*resubscribe/i);
  });

  it("🔴 works: the flag is lifted, a fresh yes is recorded, and the address is mailable again", async () => {
    const c = await unsubscribedByLink("again@example.com");
    expect(await suppressions("again@example.com")).toEqual([{ kind: "unsubscribe", source: "unsubscribe_link" }]);
    expect((await audienceOf([c.id])).skipped).toEqual([{ id: c.id, reason: "unsubscribed" }]);

    const before = Date.now();
    const res = await resubscribe(c.token);
    expect(res.status).toBe(200);
    expect(res.text).toContain("You're subscribed again");

    const row = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.emailOptedOut).toBe(false);
    expect(row.emailOptedOutAt).toBeNull();
    expect(row.emailMarketingConsentSource).toBe("unsubscribe_page");
    expect(row.emailMarketingConsentAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await suppressions("again@example.com")).toEqual([]);
    expect(await audienceOf([c.id])).toEqual({ reachable: [c.id], skipped: [] });
  });

  it("🔴 never deletes a bounce or a complaint - only the unsubscribe", async () => {
    const c = await unsubscribedByLink("bounced@example.com");
    const addressHash = suppressionAddressHash(shopId, "bounced@example.com")!;
    await prisma.emailAddressSuppression.createMany({
      data: [
        { shopId, addressHash, kind: "bounce", source: "provider_webhook" },
        { shopId, addressHash, kind: "complaint", source: "provider_webhook" },
      ],
    });
    expect((await resubscribe(c.token)).status).toBe(200);
    expect(await suppressions("bounced@example.com")).toEqual([
      { kind: "bounce", source: "provider_webhook" },
      { kind: "complaint", source: "provider_webhook" },
    ]);
    // Their yes is back, and the provider's refusal still keeps mail away.
    expect((await audienceOf([c.id])).skipped).toEqual([{ id: c.id, reason: "undeliverable" }]);
  });

  it("🔴 a bad token is refused and changes nothing", async () => {
    const c = await unsubscribedByLink("stays.out@example.com");
    const res = await resubscribe(`${c.token.slice(0, -4)}AAAA`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("We couldn't turn emails back on");
    expect(res.text).not.toContain("subscribed again");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).emailOptedOut).toBe(true);
    expect(await suppressions("stays.out@example.com")).toEqual([{ kind: "unsubscribe", source: "unsubscribe_link" }]);
  });

  it("🔴 a GET - a scanner following the URL - reaches nothing", async () => {
    const c = await unsubscribedByLink("scanned@example.com");
    const res = await request(app).get(`/api/unsubscribe/${c.token}/resubscribe`);
    expect(res.status).toBe(404);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).emailOptedOut).toBe(true);
    expect(await suppressions("scanned@example.com")).toEqual([{ kind: "unsubscribe", source: "unsubscribe_link" }]);
  });

  it("a record with no address left is refused", async () => {
    const c = await unsubscribedByLink("deleted.later@example.com");
    await prisma.client.update({ where: { id: c.id }, data: { email: null } });
    expect((await resubscribe(c.token)).status).toBe(404);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).emailOptedOut).toBe(true);
  });
});

describe("the shop records one client's yes", () => {
  const record = (id: string, method: unknown) =>
    request(app).post(`/api/dashboard/clients/${id}/email-marketing`).set("Cookie", cookie).send({ method });
  const remove = (id: string) =>
    request(app).delete(`/api/dashboard/clients/${id}/email-marketing`).set("Cookie", cookie);
  const row = (id: string) => prisma.client.findUniqueOrThrow({ where: { id } });

  it("records how they said yes, dated, and the client page shows it", async () => {
    const c = await existing({ phone: newPhone(), email: "inperson@example.com" });
    const res = await record(c.id, "in_person");
    expect(res.status).toBe(200);
    expect(res.body.emailMarketing).toMatchObject({ state: "opted_in", source: "staff:in_person" });
    expect((await row(c.id)).emailMarketingConsentSource).toBe("staff:in_person");

    const detail = await request(app).get(`/api/dashboard/clients/${c.id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.client.emailMarketing).toMatchObject({ state: "opted_in", source: "staff:in_person" });
    expect(Date.parse(detail.body.client.emailMarketing.at)).not.toBeNaN();
  });

  it("each way of saying yes is its own source", async () => {
    for (const method of ["by_text", "by_email", "paper_form"]) {
      const c = await existing({ phone: newPhone(), email: `${method}@example.com` });
      expect((await record(c.id, method)).status).toBe(200);
      expect((await row(c.id)).emailMarketingConsentSource).toBe(`staff:${method}`);
    }
  });

  it("an unknown way, or none, is refused", async () => {
    const c = await existing({ phone: newPhone(), email: "bad@example.com" });
    expect((await record(c.id, "whole_list")).status).toBe(400);
    expect((await record(c.id, undefined)).status).toBe(400);
    expect((await row(c.id)).emailMarketingConsentAt).toBeNull();
  });

  it("refused with no address on file", async () => {
    const c = await existing({ phone: newPhone(), email: null });
    const res = await record(c.id, "in_person");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_email");
    expect((await row(c.id)).emailMarketingConsentAt).toBeNull();
  });

  it("🔴 refused after an unsubscribe - only the customer can opt back in", async () => {
    const c = await existing({ phone: newPhone(), email: "out@example.com", emailOptedOut: true });
    const res = await record(c.id, "paper_form");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("unsubscribed");
    expect(res.body.message).toMatch(/only they can/i);
    const after = await row(c.id);
    expect(after.emailOptedOut).toBe(true);
    expect(after.emailMarketingConsentAt).toBeNull();
    expect(res.body.emailMarketing.state).toBe("opted_out");
  });

  it("a customer's own earlier yes stands (first wins)", async () => {
    const c = await existing({
      phone: newPhone(),
      email: "own@example.com",
      emailMarketingConsentAt: EARLIER,
      emailMarketingConsentSource: "booking_page",
    });
    expect((await record(c.id, "in_person")).status).toBe(200);
    expect((await row(c.id)).emailMarketingConsentSource).toBe("booking_page");
  });

  it("another shop's client is a plain 404", async () => {
    expect((await record(otherShopClientId, "in_person")).status).toBe(404);
    expect((await remove(otherShopClientId)).status).toBe(404);
  });

  it("the shop can take back a yes it recorded", async () => {
    const c = await existing({ phone: newPhone(), email: "undo@example.com" });
    expect((await record(c.id, "by_text")).status).toBe(200);
    const res = await remove(c.id);
    expect(res.status).toBe(200);
    expect(res.body.emailMarketing).toMatchObject({ state: "needs_consent", at: null, source: null });
    const after = await row(c.id);
    expect(after.emailMarketingConsentAt).toBeNull();
    expect(after.emailMarketingConsentSource).toBeNull();
  });

  it("🔴 but never a yes the customer gave themselves", async () => {
    const c = await existing({
      phone: newPhone(),
      email: "mine@example.com",
      emailMarketingConsentAt: EARLIER,
      emailMarketingConsentSource: "customer_settings",
    });
    const res = await remove(c.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("customer_yes");
    const after = await row(c.id);
    expect(after.emailMarketingConsentAt).toEqual(EARLIER);
    expect(after.emailMarketingConsentSource).toBe("customer_settings");
  });
});
