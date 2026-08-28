import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __setMessageProviderForTests,
} from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import {
  notifyQueueHead,
  notifyWalkInReady,
  notifyWalkInRemoved,
} from "./walkInNotify.js";
import {
  assignEntry,
  claimEntry,
  createEntryByStaff,
  markReady,
  returnToLine,
  type QueueActor,
} from "../engines/walkInQueue.js";

/**
 * The queue pings, against the deterministic transport:
 *
 *   - READY notifies once per SUMMON (the stamp is CAS-claimed; return
 *     re-arms it);
 *   - "you're next" fires once per entry LIFETIME;
 *   - a staff cancel sends the released notice;
 *   - consent and STOP are respected; and a failed/absent send never
 *     touches the queue.
 */

let userId: string;
let shopId: string;
let chairA: string;
let svc30: string;
let phoneSeq = 0;
let sent: SendMessageInput[] = [];

const NOW = new Date("2026-09-02T15:00:00.000Z");
const MANAGER: Extract<QueueActor, { kind: "manager" }> = {
  kind: "manager",
  userId: null,
  staffId: null,
};

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(9000 + phoneSeq).padStart(4, "0")}`;
}

async function makeEntry(over: { consent?: boolean; phone?: string } = {}) {
  const phone = over.phone ?? freshPhone();
  const e = await createEntryByStaff({
    shopId,
    timezone: "UTC",
    actor: MANAGER,
    input: { firstName: `N${phoneSeq}`, phone, serviceIds: [svc30] },
    now: NOW,
  });
  if (over.consent !== false) {
    await prisma.walkInEntry.update({
      where: { id: e.id },
      data: {
        smsConsentAt: NOW,
        smsConsentSource: "walk_in_kiosk",
        smsConsentVersion: "v1",
        smsConsentPhone: phone,
      },
    });
  }
  return { ...e, phone };
}

beforeAll(async () => {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sent.push(input);
      return { sid: `T${sent.length}`, status: "sent" };
    },
  });
  const user = await prisma.user.create({
    data: { email: `wn-${randomToken(6)}@test.local`, name: "WN" },
    select: { id: true },
  });
  userId = user.id;
  MANAGER.userId = userId;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Notify Cuts",
      slug: `wn-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      walkInEnabled: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
});

afterEach(async () => {
  sent = [];
  // Each test owns a clean line (stamps are per-entry, so nuking rows is the
  // simplest isolation).
  await prisma.walkInEvent.deleteMany({ where: { shopId } });
  await prisma.walkInEntry.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("barber is ready", () => {
  it("sends once per summon - a repeat is swallowed by the stamp, a re-summon re-arms", async () => {
    const e = await makeEntry();
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    await markReady({ shopId, entryId: e.id, actor: MANAGER, now: NOW });

    await notifyWalkInReady(shopId, e.id, NOW);
    await notifyWalkInReady(shopId, e.id, NOW); // the raced/double route hit
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(e.phone);
    expect(sent[0]!.body).toMatch(/Ava is ready/);

    // Return to line re-arms; the NEXT summon notifies again.
    await returnToLine({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    await markReady({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    await notifyWalkInReady(shopId, e.id, NOW);
    expect(sent).toHaveLength(2);
  });

  it("without kiosk consent there is NO text - and the queue is untouched", async () => {
    const e = await makeEntry({ consent: false });
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    await markReady({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    await notifyWalkInReady(shopId, e.id, NOW);
    expect(sent).toHaveLength(0);
    const row = await prisma.walkInEntry.findUnique({ where: { id: e.id } });
    expect(row!.status).toBe("READY"); // a silent ping never moves state
  });

  it("a STOPped client blocks the text - STOP is absolute even for transactional", async () => {
    const phone = freshPhone();
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone,
        firstName: "Stopped",
        phone,
        optedOut: true,
        magicToken: randomToken(),
      },
    });
    const e = await makeEntry({ phone });
    await assignEntry({ shopId, entryId: e.id, staffId: chairA, actor: MANAGER, now: NOW });
    await markReady({ shopId, entryId: e.id, actor: MANAGER, now: NOW });
    await notifyWalkInReady(shopId, e.id, NOW);
    expect(sent).toHaveLength(0);
  });
});

describe("you're next", () => {
  it("pings the head of the line exactly once per entry lifetime", async () => {
    const first = await makeEntry();
    await makeEntry(); // someone behind them
    await notifyQueueHead(shopId, NOW);
    await notifyQueueHead(shopId, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(first.phone);
    expect(sent[0]!.body).toMatch(/next in line/i);
  });

  it("when the head is claimed, the NEXT head gets its (one) ping", async () => {
    const first = await makeEntry();
    const second = await makeEntry();
    await notifyQueueHead(shopId, NOW); // first's ping
    await claimEntry({
      shopId,
      entryId: first.id,
      actor: { kind: "barber", userId, staffId: chairA },
      now: NOW,
    });
    await notifyQueueHead(shopId, NOW); // the hook the claim route fires
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe(second.phone);
  });

  it("an empty line pings nobody", async () => {
    await notifyQueueHead(shopId, NOW);
    expect(sent).toHaveLength(0);
  });
});

describe("spot released", () => {
  it("a CANCELED entry gets the released notice; active or missing entries get nothing", async () => {
    const e = await makeEntry();
    await notifyWalkInRemoved(shopId, e.id, NOW); // still WAITING - no send
    expect(sent).toHaveLength(0);
    await prisma.walkInEntry.update({
      where: { id: e.id },
      data: { status: "CANCELED", canceledAt: NOW },
    });
    await notifyWalkInRemoved(shopId, e.id, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/was released/i);
  });
});
