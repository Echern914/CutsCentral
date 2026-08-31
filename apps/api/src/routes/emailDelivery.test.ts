import request from "supertest";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { verifySvixSignature } from "./webhooks.resend.js";
import { runAsOwner } from "@chairback/db";
import {
  applyEmailEvent,
  applyEventInTx,
  readEmailDeliverySummary,
  recordEmailSent,
} from "../services/emailDelivery.js";

/**
 * Email delivery observability.
 *
 * The gap this closes: a send was fire-and-forget, so inbox, spam and hard
 * bounce were indistinguishable from inside ChairBack. The contract is that a
 * provider event lands on the right record, is idempotent under retry, never
 * lets a late success bury a bounce, and leaks nothing from a payload that
 * contains the recipient's address and the rendered subject.
 */

const app = createApp();
const SECRET = "whsec_" + Buffer.from("supersecretwebhookkey0123").toString("base64");
const emails: string[] = [];

function signed(body: object, over: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const id = `msg_${randomToken(6)}`;
  const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((over.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { raw, id, ts, sig: `v1,${sig}` };
}

const post = (body: object, over: { secret?: string; ts?: number; sig?: string } = {}) => {
  const s = signed(body, over);
  return request(app)
    .post("/webhooks/resend")
    .set("Content-Type", "application/json")
    .set("svix-id", s.id)
    .set("svix-timestamp", s.ts)
    .set("svix-signature", over.sig ?? s.sig)
    .send(s.raw);
};

async function seed(messageId: string, kind = "confirmation"): Promise<void> {
  await prisma.emailDelivery.create({
    data: { messageId, kind, status: "sent" },
  });
}

/** Apply one event under a fresh svix delivery id. */
const apply = (messageId: string, event: string) =>
  applyEmailEvent({ messageId, event, svixId: `svix_${randomToken(8)}` });

beforeAll(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

afterEach(async () => {
  await prisma.emailWebhookEvent.deleteMany({ where: { messageId: { in: emails } } });
  await prisma.emailDelivery.deleteMany({ where: { messageId: { in: emails } } });
  emails.length = 0;
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});

afterAll(async () => {
  delete process.env.RESEND_WEBHOOK_SECRET;
  await prisma.$disconnect();
});

describe("signature verification", () => {
  it("accepts a correctly signed payload", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const res = await post({ type: "email.delivered", data: { email_id: id } });
    expect(res.status).toBe(200);
  });

  it("refuses a wrong secret, a tampered body and a missing header", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const body = { type: "email.bounced", data: { email_id: id } };

    const wrongSecret = "whsec_" + Buffer.from("thewrongkey00000000000000").toString("base64");
    expect((await post(body, { secret: wrongSecret })).status).toBe(401);
    expect((await post(body, { sig: "v1,bm90YXNpZ25hdHVyZQ==" })).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/webhooks/resend")
          .set("Content-Type", "application/json")
          .send(JSON.stringify(body))
      ).status,
    ).toBe(401);

    // Refused means UNAPPLIED - a forged bounce must not mark a real send bad.
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("sent");
  });

  it("refuses a replayed timestamp outside the tolerance", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const old = Math.floor(Date.now() / 1000) - 60 * 60;
    expect((await post({ type: "email.delivered", data: { email_id: id } }, { ts: old })).status).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    expect((await post({ type: "email.delivered", data: { email_id: id } })).status).toBe(401);
  });

  it("accepts any signature in the list, so a secret rotation does not drop events", () => {
    const raw = Buffer.from(JSON.stringify({ hello: "world" }));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const good = createHmac("sha256", key).update(`id1.100.`).update(raw).digest("base64");
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: "id1",
        timestamp: "100",
        signature: `v1,bm9wZQ== v1,${good}`,
        body: raw,
        now: new Date(100 * 1000),
      }),
    ).toBe(true);
  });
});

describe("applying events", () => {
  it("moves a send to delivered", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("classifies a bounce and a complaint with fixed vocabulary", async () => {
    for (const [event, status, cls] of [
      ["email.bounced", "bounced", "hard_bounce"],
      ["email.complained", "complained", "complaint"],
    ] as const) {
      const id = `em_${randomToken(8)}`;
      emails.push(id);
      await seed(id);
      await post({ type: event, data: { email_id: id } });
      const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      expect(row!.status).toBe(status);
      expect(row!.failureClass).toBe(cls);
      expect(row!.failedAt).not.toBeNull();
    }
  });

  it("🔴 never lets a late 'delivered' bury a bounce", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.bounced", data: { email_id: id } });
    await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced"); // bad news survives
    expect(row!.eventCount).toBe(2); // but the event is still counted
  });

  it("is idempotent - a retried webhook changes nothing but the count", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    for (let i = 0; i < 3; i++) await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.eventCount).toBe(3);
  });

  it("RETAINS an event for a message it never recorded, rather than discarding it", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    const res = await post({ type: "email.delivered", data: { email_id: id } });
    expect(res.status).toBe(200);
    // A verified event is evidence; creating the row is what stops a bounce
    // disappearing because the provider beat our own metadata write.
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("delivered");
    expect(row!.awaitingDispatchMeta).toBe(true);
    // A second, identical event advances nothing - but is still counted.
    expect(await applyEmailEvent({ messageId: id, event: "email.delivered" })).toBe(
      "ignored",
    );
    expect(
      (await prisma.emailDelivery.findUnique({ where: { messageId: id } }))!.eventCount,
    ).toBe(2);
  });

  it("ignores an event type outside the vocabulary", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    expect(await applyEmailEvent({ messageId: id, event: "email.opened" })).toBe("ignored");
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("sent");
  });

  it("acks a malformed body from a correctly signed sender", async () => {
    const s = signed({});
    const raw = "{not json";
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", key).update(`${s.id}.${s.ts}.${raw}`).digest("base64");
    const res = await request(app)
      .post("/webhooks/resend")
      .set("Content-Type", "application/json")
      .set("svix-id", s.id)
      .set("svix-timestamp", s.ts)
      .set("svix-signature", `v1,${sig}`)
      .send(raw);
    expect(res.status).toBe(200); // do not make Resend retry forever
  });
});

describe("what the ledger and its logs may contain", () => {
  it("stores no address, subject or body", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({
      type: "email.bounced",
      data: {
        email_id: id,
        to: ["casey@example.com"],
        subject: "Booking confirmed: Skin Fade at Drick's",
        text: "the whole rendered body",
      },
    });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    const flat = JSON.stringify(row);
    expect(flat).not.toContain("casey@example.com");
    expect(flat).not.toContain("Skin Fade");
    expect(flat).not.toContain("rendered body");
  });

  it("logs the event name and outcome only - never the payload", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      await post({
        type: "email.delivered",
        data: { email_id: id, to: ["casey@example.com"], subject: "Skin Fade" },
      });
      const logged = JSON.stringify(infoSpy.mock.calls);
      expect(logged).not.toContain("casey@example.com");
      expect(logged).not.toContain("Skin Fade");
      expect(logged).toContain("email.delivered");
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("the admin summary", () => {
  it("counts by status and by kind", async () => {
    const ids = [`em_${randomToken(8)}`, `em_${randomToken(8)}`, `em_${randomToken(8)}`];
    emails.push(...ids);
    await seed(ids[0]!, "confirmation");
    await seed(ids[1]!, "confirmation");
    await seed(ids[2]!, "cancellation");
    await post({ type: "email.bounced", data: { email_id: ids[1]! } });

    const summary = await readEmailDeliverySummary(new Date(), 7);
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.byKind["confirmation"]!.bounced).toBeGreaterThanOrEqual(1);
    expect(summary.byStatus["bounced"]).toBeGreaterThanOrEqual(1);
  });
});

describe("race and replay safety", () => {
  it("KEEPS an event that arrives before the sender's own metadata write", async () => {
    // The provider is routinely faster than our fire-and-forget write. The
    // old code returned unknown_message and threw the event away - which is
    // how a bounce could vanish entirely.
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    const res = await post({ type: "email.bounced", data: { email_id: id } });
    expect(res.status).toBe(200);

    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("bounced");
    expect(row!.failureClass).toBe("hard_bounce");
    expect(row!.awaitingDispatchMeta).toBe(true);
  });

  it("attaches late dispatch metadata WITHOUT overwriting the newer status", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    // Event first...
    await post({ type: "email.bounced", data: { email_id: id } });
    // ...then our own write lands, carrying the correlation the event lacked.
    recordEmailSent(id, {
      to: "casey@example.com",
      subject: "Booking confirmed",
      text: "x",
      meta: { shopId: "shop_1", appointmentId: "appt_1", kind: "confirmation" },
    });
    await new Promise((r) => setTimeout(r, 300));

    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.kind).toBe("confirmation"); // metadata attached
    expect(row!.shopId).toBe("shop_1");
    expect(row!.appointmentId).toBe("appt_1");
    expect(row!.awaitingDispatchMeta).toBe(false);
    // 🔴 And the outcome the provider already reported is untouched.
    expect(row!.status).toBe("bounced");
    expect(row!.failureClass).toBe("hard_bounce");
  });

  it("REPLAYING the same svix-id changes nothing at all", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);

    const s = signed({ type: "email.delivered", data: { email_id: id } });
    const send = () =>
      request(app)
        .post("/webhooks/resend")
        .set("Content-Type", "application/json")
        .set("svix-id", s.id)
        .set("svix-timestamp", s.ts)
        .set("svix-signature", s.sig)
        .send(s.raw);

    expect((await send()).status).toBe(200);
    const first = await prisma.emailDelivery.findUnique({ where: { messageId: id } });

    // Svix retries the SAME delivery - three more times.
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);

    const after = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(after!.eventCount).toBe(first!.eventCount); // no inflation
    expect(after!.status).toBe(first!.status);
    expect(after!.deliveredAt?.getTime()).toBe(first!.deliveredAt?.getTime());
    // Exactly one delivery record was kept.
    expect(
      await prisma.emailWebhookEvent.count({ where: { svixId: s.id } }),
    ).toBe(1);
  });

  it("counts DISTINCT deliveries of the same event separately", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.delivered", data: { email_id: id } });
    await post({ type: "email.delivered", data: { email_id: id } }); // new svix id
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.eventCount).toBe(2);
  });

  it("clears a STALE deferral once delivery actually succeeds", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.delivery_delayed", data: { email_id: id } });
    let row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("deferred");
    expect(row!.failureClass).toBe("deferred");

    await post({ type: "email.delivered", data: { email_id: id } });
    row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    // Leaving the stale class would report a delivered message as troubled.
    expect(row!.failureClass).toBeNull();
  });

  it("🔴 but a TERMINAL failure still wins over a later success", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.bounced", data: { email_id: id } });
    await post({ type: "email.delivered", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced");
    expect(row!.failureClass).toBe("hard_bounce");
    expect(row!.eventCount).toBe(2); // seen, counted, not obeyed
  });

  it("an unknown event type cannot corrupt an established state", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await post({ type: "email.bounced", data: { email_id: id } });
    await post({ type: "email.opened", data: { email_id: id } });
    await post({ type: "not.an.event", data: { email_id: id } });
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced");
    expect(row!.eventCount).toBe(1); // unknown types are not counted either
  });
});

describe("the replay marker and the state change are ONE transaction", () => {
  it("🔴 a crash after the marker rolls BOTH back, so the retry still applies", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);

    // Model "the process died between inserting the marker and updating the
    // ledger" by aborting the very transaction the production path uses.
    // Committing the marker separately was the bug: svix would retry, see a
    // duplicate, refuse to apply, and the bounce would be lost forever.
    const svixId = `svix_${randomToken(8)}`;
    await expect(
      runAsOwner(async (tx) => {
        await applyEventInTx(tx, { messageId: id, event: "email.bounced", svixId });
        throw new Error("process died mid-transaction");
      }),
    ).rejects.toThrow();

    // Neither half survived.
    expect(await prisma.emailWebhookEvent.count({ where: { svixId } })).toBe(0);
    expect(
      (await prisma.emailDelivery.findUnique({ where: { messageId: id } }))!.status,
    ).toBe("sent");

    // The retry lands properly.
    expect(await applyEmailEvent({ messageId: id, event: "email.bounced", svixId })).toBe(
      "applied",
    );
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced");
    expect(await prisma.emailWebhookEvent.count({ where: { svixId } })).toBe(1);
  });

  it("two concurrent FIRST events for an unknown message both record, neither is lost", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    const a = `svix_${randomToken(8)}`;
    const b = `svix_${randomToken(8)}`;

    // Both race to create the delivery row; the loser blocks on the winner's
    // insert and then applies its own event on top, instead of dying on the
    // unique index or falling into a reduced update branch.
    const [ra, rb] = await Promise.all([
      applyEmailEvent({ messageId: id, event: "email.delivered", svixId: a }),
      applyEmailEvent({ messageId: id, event: "email.bounced", svixId: b }),
    ]);
    expect([ra, rb].every((r) => r !== "error" && r !== "duplicate")).toBe(true);

    // Both deliveries are on record...
    expect(await prisma.emailWebhookEvent.count({ where: { svixId: { in: [a, b] } } })).toBe(2);
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row).not.toBeNull();
    // ...and the bounce wins regardless of which order they landed in.
    expect(row!.status).toBe("bounced");
    expect(row!.eventCount).toBe(2);
  });

  it("🔴 a replayed svix id changes nothing WITHOUT aborting the transaction", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    const svixId = `svix_${randomToken(8)}`;
    expect(await applyEmailEvent({ messageId: id, event: "email.delivered", svixId })).toBe(
      "applied",
    );
    const first = await prisma.emailDelivery.findUnique({ where: { messageId: id } });

    await runAsOwner(async (tx) => {
      expect(
        await applyEventInTx(tx, { messageId: id, event: "email.delivered", svixId }),
      ).toBe("duplicate");
      // 🔴 THE POINT. Catching a P2002 in JavaScript does not un-abort the
      // POSTGRES transaction: with the old `create` + catch, this next
      // statement failed with 25P02 and the "duplicate" answer was only ever
      // correct because nothing was attempted after it.
      const rows = await tx.$queryRaw<{ ok: number }[]>(Prisma.sql`SELECT 1 AS ok`);
      expect(rows[0]!.ok).toBe(1);
    });

    const after = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(after!.eventCount).toBe(first!.eventCount);
    expect(after!.status).toBe(first!.status);
  });

  it("🔴 a replay SHORT-CIRCUITS: every column is byte-identical afterwards", async () => {
    // Two rows, so the pin covers deferral information AND a terminal
    // classification sitting on top of a delivery - the two shapes a
    // re-applied transition would disturb differently.
    for (const build of [
      // A deferred row, carrying deferral information.
      async (id: string) => {
        const sv = `svix_${randomToken(8)}`;
        await applyEmailEvent({ messageId: id, event: "email.delivery_delayed", svixId: sv });
        return sv;
      },
      // A terminal classification sitting on top of a real delivery.
      async (id: string) => {
        await apply(id, "email.delivered");
        const sv = `svix_${randomToken(8)}`;
        await applyEmailEvent({ messageId: id, event: "email.bounced", svixId: sv });
        return sv;
      },
    ]) {
      const id = `em_${randomToken(8)}`;
      emails.push(id);
      await seed(id);
      // Replayed under the marker of the LAST event applied - and replayed as
      // a BOUNCE, which would certainly change the deferred row if the
      // short-circuit were not there.
      const target = await build(id);

      const before = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      // A pause, so that ANY stray write would move updatedAt detectably.
      await new Promise((r) => setTimeout(r, 40));

      for (let i = 0; i < 3; i++) {
        // 🔴 The marker insert reports whether it actually inserted; zero rows
        // means seen-before, and the transition is never reached.
        expect(
          await applyEmailEvent({ messageId: id, event: "email.bounced", svixId: target }),
        ).toBe("duplicate");
      }

      const after = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      // Every column: status, failureClass, deliveredAt, failedAt, eventCount,
      // awaitingDispatchMeta - and updatedAt, which no-ops leave alone.
      expect(after).toEqual(before);
      expect(await prisma.emailWebhookEvent.count({ where: { svixId: target } })).toBe(1);
    }
  });

  it("a metadata write racing a webhook cannot walk the status backward", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await post({ type: "email.bounced", data: { email_id: id } });
    // The sender's own write arrives late, as it routinely does.
    recordEmailSent(id, {
      to: "casey@example.com",
      subject: "Booking confirmed",
      text: "x",
      meta: { shopId: "shop_x", kind: "confirmation" },
    });
    await new Promise((r) => setTimeout(r, 300));
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced"); // not "sent"
    expect(row!.kind).toBe("confirmation"); // metadata still attached
  });
});

/**
 * 🔴 A record only ever moves FORWARD: sent → deferred → delivered → terminal.
 *
 * Provider events arrive out of order as a matter of course, so "latest event
 * wins" reports whichever one happened to land last rather than what happened
 * to the mail. The concurrency case is the one that hid the defect: two FIRST
 * events for an unknown message used to take a reduced update branch that
 * counted the second event but applied it only if it was terminal - so
 * `sent` + `delivered` left a delivered message reading "sent".
 */
describe("status transitions are monotonic", () => {
  /**
   * FORCE the interleaving rather than hope for it.
   *
   * `Promise.all` of two applies is not a race - the pool serialises them often
   * enough that the defect hides. Here the first event is applied inside a
   * transaction that is deliberately HELD OPEN while the second one runs, so
   * the second genuinely finds no row, blocks on the first's uncommitted
   * insert, and only then proceeds. That is the exact interleaving in which the
   * old "lost the create race" branch counted an event without applying it.
   */
  async function forcedFirstEventRace(
    messageId: string,
    firstEvent: string,
    secondEvent: string,
  ): Promise<void> {
    let allowCommit!: () => void;
    const mayCommit = new Promise<void>((r) => (allowCommit = r));
    let announceApplied!: () => void;
    const applied = new Promise<void>((r) => (announceApplied = r));

    const first = runAsOwner(async (tx) => {
      await applyEventInTx(tx, {
        messageId,
        event: firstEvent,
        svixId: `svix_${randomToken(8)}`,
      });
      announceApplied();
      await mayCommit; // hold the row uncommitted while the second one starts
    });

    await applied;
    const second = apply(messageId, secondEvent);
    // Long enough for the second transaction to reach the insert and block.
    await new Promise((r) => setTimeout(r, 200));
    allowCommit();
    await Promise.all([first, second]);
  }

  it("🔴 forced concurrent first events 'sent' and 'delivered' settle on DELIVERED", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    // NEITHER IS TERMINAL, which is exactly why the old special-cased update
    // branch counted the delivered event and then dropped its transition: the
    // message read "sent" forever despite having been delivered.
    await forcedFirstEventRace(id, "email.sent", "email.delivered");
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
    expect(row!.eventCount).toBe(2); // counted once each
  });

  it("forced concurrent 'delivery_delayed' and 'delivered' settle on DELIVERED either way", async () => {
    for (const [a, b] of [
      ["email.delivery_delayed", "email.delivered"],
      ["email.delivered", "email.delivery_delayed"],
    ] as const) {
      const id = `em_${randomToken(8)}`;
      emails.push(id);
      await forcedFirstEventRace(id, a, b);
      const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      expect(row!.status).toBe("delivered");
      expect(row!.failureClass).toBeNull(); // the deferral is stale once it lands
      expect(row!.eventCount).toBe(2);
    }
  });

  it("forced concurrent 'delivered' and 'bounced' keep the BOUNCE either way", async () => {
    for (const [a, b] of [
      ["email.delivered", "email.bounced"],
      ["email.bounced", "email.delivered"],
    ] as const) {
      const id = `em_${randomToken(8)}`;
      emails.push(id);
      await forcedFirstEventRace(id, a, b);
      const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
      expect(row!.status).toBe("bounced");
      expect(row!.failureClass).toBe("hard_bounce");
      expect(row!.eventCount).toBe(2);
    }
  });

  it("a late 'sent' or 'deferred' cannot downgrade a DELIVERED message", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await apply(id, "email.delivered");
    const deliveredAt = (await prisma.emailDelivery.findUnique({
      where: { messageId: id },
    }))!.deliveredAt;

    await apply(id, "email.sent");
    await apply(id, "email.delivery_delayed");

    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("delivered");
    expect(row!.failureClass).toBeNull(); // no phantom deferral after delivery
    expect(row!.deliveredAt?.getTime()).toBe(deliveredAt?.getTime());
    expect(row!.eventCount).toBe(3); // all three seen and counted
  });

  it("a second terminal event does not overwrite the first", async () => {
    const id = `em_${randomToken(8)}`;
    emails.push(id);
    await seed(id);
    await apply(id, "email.bounced");
    await apply(id, "email.complained");
    const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
    expect(row!.status).toBe("bounced"); // the first terminal outcome stands
    expect(row!.failureClass).toBe("hard_bounce");
    expect(row!.eventCount).toBe(2);
  });

  /**
   * The precedence the ledger must obey, declared HERE independently of the
   * implementation so this is a specification rather than a mirror of it.
   */
  const PRECEDENCE: Record<string, number> = {
    sent: 0,
    deferred: 1,
    delivered: 2,
    bounced: 3,
    complained: 3,
    failed: 3,
  };
  const EVENT_FOR: Record<string, string> = {
    sent: "email.sent",
    deferred: "email.delivery_delayed",
    delivered: "email.delivered",
    bounced: "email.bounced",
    complained: "email.complained",
    failed: "email.failed",
  };

  it("🔴 transition matrix: nothing can reverse a higher-precedence state", async () => {
    const states = Object.keys(EVENT_FOR);
    for (const from of states) {
      for (const to of states) {
        const id = `em_${randomToken(8)}`;
        emails.push(id);
        await prisma.emailDelivery.create({
          data: { messageId: id, kind: "matrix", status: from },
        });
        await apply(id, EVENT_FOR[to]!);
        const row = await prisma.emailDelivery.findUnique({ where: { messageId: id } });
        // A strictly higher rank advances; equal or lower leaves the state
        // alone. Ties keep the INCUMBENT, so the first terminal outcome stands.
        const expected = PRECEDENCE[to]! > PRECEDENCE[from]! ? to : from;
        // Encoded into the assertion so a failure names the offending pair.
        expect(`${from}+${to} -> ${row!.status}`).toBe(`${from}+${to} -> ${expected}`);
        expect(row!.eventCount).toBe(1); // seen and counted either way
      }
    }
  });

  it("🔴 a delivery it could not record is NOT acknowledged, so the provider retries", async () => {
    // A message id no btree index can hold, so the write genuinely fails.
    // Nothing commits - marker included - and answering 200 would spend the
    // provider's only retry on an event we dropped, which is precisely how a
    // bounce goes missing.
    // Random, so btree cannot compress it under the index-tuple limit.
    const unstorable = `em_${Array.from({ length: 300 }, () => randomToken(16)).join("")}`;
    expect(
      await applyEmailEvent({
        messageId: unstorable,
        event: "email.bounced",
        svixId: `svix_${randomToken(8)}`,
      }),
    ).toBe("error");
    expect(await prisma.emailDelivery.count({ where: { messageId: unstorable } })).toBe(0);

    // And the receiver says so, rather than acking a delivery it lost.
    const res = await post({ type: "email.bounced", data: { email_id: unstorable } });
    expect(res.status).toBe(500);
  });
});
