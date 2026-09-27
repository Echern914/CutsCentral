import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { ingestAppointment } from "../ingest.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { runBroadcastWorker } from "../engines/broadcastWorker.js";
import { unsubscribeDigestFor, unsubscribeTokenFor } from "../engines/unsubscribeToken.js";
import type { AcuityAppointment } from "../acuity/types.js";

/**
 * 🔴 AN EMAIL UNSUBSCRIBE MUST OUTLIVE A MERGE AND EVERY LATER SYNC OR IMPORT.
 *
 * One person, followed end to end through the real paths: synced from Acuity
 * on two phone numbers (two records), unsubscribed from one record through the
 * real unsubscribe link, the two records merged, then the person reappearing -
 * the next Acuity sync under the merged record's retired key creates a fresh
 * record, and a CSV import adds another with the address typed differently.
 *
 * Before the fix, the merge dropped the unsubscribe and every re-created
 * record was mailable, so one merge quietly put an unsubscribed person back on
 * the shop's marketing list. Now the choice holds on every record that carries
 * the address - without rewriting those records - and the one message a send
 * delivers goes only to the control client.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
let cookie = "";
let shopId = "";
let outbox: SendEmailInput[] = [];

const PERSON_EMAIL = "p.unsub@example.invalid";
const PHONE_A = "+13025550181";
const PHONE_B = "+13025550182";

function appt(id: number, phone: string, email: string, daysAgo: number): AcuityAppointment {
  const start = new Date(Date.now() - daysAgo * 86_400_000);
  start.setUTCHours(15, 0, 0, 0);
  return {
    id: String(id),
    firstName: "Pat",
    lastName: "Unsub",
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
}

async function ingest(a: AcuityAppointment) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  await ingestAppointment(shop, "scheduled", a.id, a);
}

const byKey = (key: string) =>
  prisma.client.findUniqueOrThrow({
    where: { shopId_acuityClientKey: { shopId, acuityClientKey: key } },
  });

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    return { id: `test-${outbox.length}-${randomToken(4)}`, status: "sent" as const };
  });
  const email = `unsub-merge-${randomToken(6).toLowerCase()}@test.chairback`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Unsub Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  // A marketing email needs a postal address in its footer.
  await prisma.shop.update({
    where: { id: shopId },
    data: { addressStreet: "12 Main St", addressCity: "Newark", addressRegion: "NJ", addressPostal: "07102" },
  });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  for (const e of emails) {
    const user = await prisma.user.findUnique({ where: { email: e }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("an unsubscribed person, followed through merge, re-sync, import and a send", () => {
  it("stays unsubscribed on every record that carries the address", async () => {
    // Two records for one person (two phones), plus a control client.
    await ingest(appt(8101, PHONE_A, PERSON_EMAIL, 20));
    await ingest(appt(8102, PHONE_B, PERSON_EMAIL, 12));
    await ingest(appt(8103, "+13025550183", "d.keep@example.invalid", 9));
    const onA = await byKey(`tel:${PHONE_A}`);
    const onB = await byKey(`tel:${PHONE_B}`);
    // All three had said yes to marketing email - so what keeps the person
    // out below is their unsubscribe, which outranks an earlier yes.
    const control = await byKey("tel:+13025550183");
    await prisma.client.updateMany({
      where: { id: { in: [onA.id, onB.id, control.id] } },
      data: { emailMarketingConsentAt: new Date("2026-01-01T00:00:00Z"), emailMarketingConsentSource: "test" },
    });

    // Unsubscribe through the real link, exactly as the footer of a sent
    // broadcast offers it (a send stores the digest before mailing).
    await prisma.client.update({
      where: { id: onA.id },
      data: { unsubscribeTokenHash: unsubscribeDigestFor(onA.id) },
    });
    const unsub = await request(app).post(`/api/unsubscribe/${unsubscribeTokenFor(onA.id)}`);
    expect(unsub.status).toBe(200);
    const unsubscribed = await prisma.client.findUniqueOrThrow({ where: { id: onA.id } });
    expect(unsubscribed.emailOptedOut).toBe(true);

    // Merge the unsubscribed record INTO the other one.
    const merge = await request(app)
      .post(`/api/dashboard/clients/${onB.id}/merge`)
      .set("Cookie", cookie)
      .send({ loserId: onA.id });
    expect(merge.status).toBe(200);
    const survivor = await prisma.client.findUniqueOrThrow({ where: { id: onB.id } });
    expect(survivor.emailOptedOut).toBe(true);
    expect(survivor.emailOptedOutAt?.getTime()).toBe(unsubscribed.emailOptedOutAt?.getTime());

    // The next sync under the merged record's old identity makes a new record...
    await ingest(appt(8104, PHONE_A, PERSON_EMAIL, 3));
    const resynced = await byKey(`tel:${PHONE_A}`);
    expect([onA.id, onB.id]).not.toContain(resynced.id);
    // ...and so does an import, with the address typed differently.
    const imported = await request(app)
      .post("/api/dashboard/clients/import")
      .set("Cookie", cookie)
      .send({ rows: [{ firstName: "Pat", phone: "+13025550184", email: "  P.Unsub@Example.INVALID " }] });
    expect(imported.status).toBe(200);
    const fromImport = await byKey("tel:+13025550184");
    // Neither record is rewritten - the exclusion is decided at send time.
    expect(resynced.emailOptedOut).toBe(false);
    expect(fromImport.emailOptedOut).toBe(false);

    // Eligibility: only the control client is reachable.
    const preview = await request(app)
      .post("/api/broadcasts/preview")
      .set("Cookie", cookie)
      .send({ channel: "email" });
    expect(preview.status).toBe(200);
    expect(preview.body.reachable).toBe(1);
    const reasons = Object.fromEntries(
      (preview.body.skipped as { reason: string; count: number }[]).map((s) => [s.reason, s.count]),
    );
    expect(reasons).toMatchObject({ unsubscribed: 3, archived: 1 });

    // And a real send freezes the same list and delivers exactly one message.
    const drafted = await request(app)
      .post("/api/broadcasts")
      .set("Cookie", cookie)
      .send({ channel: "email", tiers: [], subject: "This week", body: "Open chairs Friday." });
    expect(drafted.status).toBe(201);
    const sent = await request(app)
      .post(`/api/broadcasts/${drafted.body.id as string}/send`)
      .set("Cookie", cookie)
      .send({});
    expect(sent.status).toBe(202);
    const rows = await prisma.broadcastSend.findMany({
      where: { broadcastId: drafted.body.id as string },
      select: { clientId: true, status: true, reason: true },
    });
    for (const id of [survivor.id, resynced.id, fromImport.id]) {
      const row = rows.find((r) => r.clientId === id);
      expect(row?.status, id).toBe("SKIPPED");
      expect(row?.reason, id).toBe("unsubscribed");
    }
    outbox = [];
    await runBroadcastWorker({ shopId });
    expect(outbox.map((m) => m.to)).toEqual(["d.keep@example.invalid"]);
  });
});
