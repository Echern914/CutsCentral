import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { SMS_CONSENT_VERSION, sha256Hex } from "../engines/waitlistJoin.js";
import { addDays, shopLocalDate } from "../engines/waitlistWindows.js";

/**
 * Waitlist phase B: the client flow.
 *
 * What is worth pinning here is not "does a row appear" but the four promises
 * the join makes to a stranger: their preferences are recorded as something a
 * machine can match, their consent is recorded as evidence, they are only in
 * the queue once, and they can get themselves out again.
 *
 * 🔴 Customer SMS stays off. The only channel this exercises is email.
 */

const app = createApp();
const suffix = (randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z").slice(0, 8);
const ownerEmail = `wl-b-${suffix}@test.local`;
const password = "supersecret123";

let cookie: string;
let slug: string;
let shopId: string;
let shopTz: string;
let sent: SendEmailInput[] = [];

/** Today in the SHOP's zone - the horizon is measured against the shop. */
const today = () => shopLocalDate(new Date(), shopTz);

const ANY = { startDate: null, endDate: null, startMin: null, endMin: null };

async function join(body: Record<string, unknown>) {
  return request(app).post(`/api/page/${slug}/waitlist`).send(body);
}

/** A join with a unique contact, so dedupe never accidentally fires. */
async function joinFresh(over: Record<string, unknown> = {}) {
  const email = `w-${randomToken(6).toLowerCase()}@test.local`;
  const res = await join({ firstName: "Wanda", email, ...over });
  return Object.assign(res, { __email: email });
}

/**
 * The join response is deliberately bare - {ok:true} and nothing else, so a
 * duplicate cannot be told apart from a new entry. Tests therefore find their
 * row by the unique contact they supplied, which is closer to how anything
 * real would find it anyway.
 */
const entryByEmail = (email: string) =>
  prisma.waitlistEntry.findFirstOrThrow({
    where: { shopId, email },
    include: { windows: true },
    orderBy: { createdAt: "desc" },
  });

const entryByPhone = (phone: string) =>
  prisma.waitlistEntry.findFirstOrThrow({
    where: { shopId, phone },
    include: { windows: true },
    orderBy: { createdAt: "desc" },
  });

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: "TEST", status: "sent" as const };
  });
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "WL Tester", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Waitlist Cuts ${suffix}`, bookingUrl: "https://wl.test", smsAttested: true });
  expect(shop.status).toBe(201);
  slug = shop.body.slug;
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ waitlistEnabled: true });
  const row = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { timezone: true },
  });
  shopTz = row.timezone;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  const user = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (user) {
    await prisma.waitlistWindow.deleteMany({ where: { shopId } });
    await prisma.waitlistEntry.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("nothing changed for a plain join", () => {
  it("🔑 a join with NO windows still works, and gets Any date / Any time", async () => {
    // This is the compatibility promise to the 118 backfilled rows: the old
    // client sends no windows, and the row it produces is identical in shape
    // to what the migration created.
    const res = await joinFresh();
    expect(res.status).toBe(201);
    const e = await entryByEmail(res.__email);
    expect(e.windows).toHaveLength(1);
    expect(e.windows[0]).toMatchObject({
      startDate: null,
      endDate: null,
      startMin: null,
      endMin: null,
    });
    expect(e.status).toBe("WAITING");
  });

  it("still accepts the old free-text preferredTime alongside", async () => {
    // 118 live rows carry it and the barber's dashboard reads it. Dropping the
    // field would blank their screen.
    const res = await joinFresh({ preferredTime: "Sat morning" });
    expect(res.status).toBe(201);
    expect((await entryByEmail(res.__email)).preferredTime).toBe("Sat morning");
  });

  it("still refuses a join with neither phone nor email", async () => {
    expect((await join({ firstName: "Nobody" })).status).toBe(400);
  });

  it("still 404s when the barber has the waitlist switched off", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ waitlistEnabled: false });
    expect((await joinFresh()).status).toBe(404);
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ waitlistEnabled: true });
  });
});

describe("structured windows", () => {
  it("stores a specific date, a range, and a time span", async () => {
    const d1 = addDays(today(), 2);
    const d2 = addDays(today(), 5);
    const res = await joinFresh({
      windows: [
        { startDate: d1, endDate: d1, startMin: null, endMin: null },
        { startDate: d1, endDate: d2, startMin: 540, endMin: 720 },
      ],
    });
    expect(res.status).toBe(201);
    const e = await entryByEmail(res.__email);
    expect(e.windows).toHaveLength(2);
    const sorted = [...e.windows].sort((a, b) => (a.startMin ?? -1) - (b.startMin ?? -1));
    expect(sorted[0]).toMatchObject({ startDate: d1, endDate: d1, startMin: null });
    expect(sorted[1]).toMatchObject({ startDate: d1, endDate: d2, startMin: 540, endMin: 720 });
  });

  it("accepts five and refuses six", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      startDate: addDays(today(), i + 1),
      endDate: addDays(today(), i + 1),
      startMin: null,
      endMin: null,
    }));
    expect((await joinFresh({ windows: five })).status).toBe(201);
    const six = [...five, { ...ANY }];
    expect((await joinFresh({ windows: six })).status).toBe(400);
  });

  it("refuses a backwards time span with an actionable code", async () => {
    const res = await joinFresh({
      windows: [{ startDate: null, endDate: null, startMin: 720, endMin: 540 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_window");
    expect(res.body.code).toBe("time_backwards");
    expect(res.body.index).toBe(0);
  });

  it("refuses a date past the 14-day horizon", async () => {
    const res = await joinFresh({
      windows: [
        {
          startDate: addDays(today(), 30),
          endDate: addDays(today(), 30),
          startMin: null,
          endMin: null,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("date_out_of_range");
  });

  it("refuses a half-set date range", async () => {
    const res = await joinFresh({
      windows: [
        { startDate: addDays(today(), 1), endDate: null, startMin: null, endMin: null },
      ],
    });
    expect(res.body.code).toBe("half_open_date");
  });
});

describe("timezone", () => {
  it("keeps a valid IANA zone", async () => {
    const res = await joinFresh({ timezone: "Europe/London" });
    expect((await entryByEmail(res.__email)).timezone).toBe("Europe/London");
  });

  it("🔑 falls back to the shop rather than rejecting the join", async () => {
    // A browser quirk must not cost the shop a customer. A wrong-but-close
    // zone still books haircuts; a 400 does not.
    const res = await joinFresh({ timezone: "Mars/Olympus" });
    expect(res.status).toBe(201);
    expect((await entryByEmail(res.__email)).timezone).toBe(shopTz);
  });
});

describe("SMS consent", () => {
  it("🔴 records nothing when the box is not ticked", async () => {
    const res = await joinFresh({ phone: "(302) 555-0111" });
    const e = await entryByEmail(res.__email);
    expect(e.smsConsentAt).toBeNull();
    expect(e.smsConsentSource).toBeNull();
    expect(e.smsConsentVersion).toBeNull();
    expect(e.smsConsentPhone).toBeNull();
  });

  it("records time, source, version AND the number that agreed", async () => {
    const res = await joinFresh({ phone: "(302) 555-0112", smsConsent: true });
    const e = await entryByEmail(res.__email);
    expect(e.smsConsentAt).toBeInstanceOf(Date);
    expect(e.smsConsentSource).toBe("waitlist_join");
    expect(e.smsConsentVersion).toBe(SMS_CONSENT_VERSION);
    // Snapshotted, and normalised: `phone` can be edited later, so a consent
    // record pointing at the live column would not be evidence of anything.
    expect(e.smsConsentPhone).toBe("+13025550112");
  });

  it("🔴 ticking the box with NO phone records no consent", async () => {
    // Consent to text a number we do not have is consent to nothing, and
    // storing it would create a record that looks like permission.
    const res = await joinFresh({ smsConsent: true });
    expect(res.status).toBe(201);
    expect((await entryByEmail(res.__email)).smsConsentAt).toBeNull();
  });

  it("🔑 joining by EMAIL with no consent still works", async () => {
    // The whole point: consent is optional, the join is not gated on it.
    const res = await joinFresh({ smsConsent: false });
    expect(res.status).toBe(201);
  });
});

describe("one active place per request", () => {
  const phone = "(302) 555-0199";

  it("refuses a second identical join, without erroring at the customer", async () => {
    const first = await join({ firstName: "Dup", phone, windows: [{ ...ANY }] });
    expect(first.status).toBe(201);
    const second = await join({ firstName: "Dup", phone, windows: [{ ...ANY }] });
    // 🔑 Indistinguishable from a fresh join: same status, same body.
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const rows = await prisma.waitlistEntry.count({
      where: { shopId, phone: "+13025550199", status: "WAITING" },
    });
    expect(rows).toBe(1);
  });

  it("🔑 but a DIFFERENT request from the same person is allowed", async () => {
    // Saturday as well as Tuesday is a real second ask. Preferences are part
    // of the identity precisely so this is not refused.
    const d = addDays(today(), 3);
    const res = await join({
      firstName: "Dup",
      phone,
      windows: [{ startDate: d, endDate: d, startMin: null, endMin: null }],
    });
    expect(res.status).toBe(201);
  });

  it("🔑 window ORDER does not create a second place", async () => {
    const a = addDays(today(), 4);
    const b = addDays(today(), 5);
    const p = "(302) 555-0177";
    const w = (x: string) => ({ startDate: x, endDate: x, startMin: null, endMin: null });
    expect((await join({ firstName: "Ord", phone: p, windows: [w(a), w(b)] })).status).toBe(
      201,
    );
    const flipped = await join({ firstName: "Ord", phone: p, windows: [w(b), w(a)] });
    expect(flipped.body).toEqual({ ok: true });
  });
});

describe("the confirmation email and self-cancellation", () => {
  it("emails a cancel link, and the raw token is NEVER stored", async () => {
    const email = `cancel-${randomToken(6).toLowerCase()}@test.local`;
    const res = await join({ firstName: "Cass", email, windows: [{ ...ANY }] });
    expect(res.status).toBe(201);

    const mail = sent.filter((m) => m.to === email).pop();
    expect(mail, "confirmation email").toBeTruthy();
    const token = /waitlist\/cancel\/([A-Za-z0-9_-]+)/.exec(mail!.text ?? "")?.[1];
    expect(token, "cancel token in the link").toBeTruthy();

    const e = await entryByEmail(email);
    // 🔑 Only the hash is at rest. A leaked backup must not cancel anyone.
    expect(e.cancelTokenHash).toBe(sha256Hex(token!));
    expect(JSON.stringify(e)).not.toContain(token!);

    const cancel = await request(app).post(`/api/page/waitlist/cancel/${token}`);
    expect(cancel.status).toBe(200);

    const after = await entryByEmail(email);
    expect(after.status).toBe("REMOVED");
    // 🔑 MARKED, not deleted - the barber's record and the consent evidence
    // both hang off this row. Same id, still there.
    expect(after.id).toBe(e.id);
  });

  it("cancelling frees the request so they can rejoin", async () => {
    const phone = "(302) 555-0155";
    expect((await join({ firstName: "Ret", phone, windows: [{ ...ANY }] })).status).toBe(201);
    const row = await entryByPhone("+13025550155");
    await prisma.waitlistEntry.update({
      where: { id: row.id },
      data: { status: "REMOVED", dedupeKey: null },
    });
    const again = await join({ firstName: "Ret", phone, windows: [{ ...ANY }] });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ok: true });
  });

  it("a bad or reused token answers the same as a good one", async () => {
    // No oracle: this endpoint takes a bearer secret, so it must not reveal
    // which tokens exist.
    for (const t of ["not-a-real-token", randomToken(32), "x".repeat(250)]) {
      const r = await request(app).post(`/api/page/waitlist/cancel/${t}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
  });

  it("does not email when the customer only left a phone", async () => {
    const before = sent.length;
    const res = await join({ firstName: "Phoney", phone: "(302) 555-0133" });
    expect(res.status).toBe(201);
    expect(sent.length).toBe(before);
  });
});
