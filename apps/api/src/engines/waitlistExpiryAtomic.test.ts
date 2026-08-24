import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * Waitlist phase F2, the atomicity clause: an entry may only be retired if the
 * record of it being retired is written too.
 *
 * This is why F1 shipped first. The whole value of the audit trail is that a
 * bad sweep can be undone exactly - and that is worth nothing if a status
 * change can survive its own audit row failing. So the audit write is made to
 * fail here, and the entry has to come out untouched.
 *
 * The mock lives in its own file because vi.mock is hoisted to the top of the
 * module: sharing a file with the ordinary sweep tests would break them all.
 */
vi.mock("./waitlistAudit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./waitlistAudit.js")>();
  return {
    ...actual,
    recordWaitlistEvent: vi.fn(async () => {
      throw new Error("audit unavailable");
    }),
  };
});

const { expireDeadWaitlistEntries } = await import("./waitlistExpiry.js");

const TZ = "America/New_York";
let shopId: string;
let entryId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-f2a-${randomToken(6)}@test.local`, name: "F2A" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Atomic Cuts",
      slug: `wl-f2a-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: TZ,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;

  const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  const entry = await prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: "Atomic",
      status: "WAITING",
      windows: { create: [{ shopId, startDate: yesterday, endDate: yesterday }] },
    },
    select: { id: true },
  });
  entryId = entry.id;
});

afterAll(async () => {
  await prisma.waitlistEntry.updateMany({
    where: { shopId, status: { in: ["WAITING", "CONTACTED"] } },
    data: { status: "REMOVED" },
  });
});

describe("the status change and its record are one transaction", () => {
  it("🔴 a failing audit insert leaves the entry WAITING, not silently expired", async () => {
    const before = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { status: true, expiresAt: true },
    });
    expect(before!.status).toBe("WAITING");

    // The sweep sees an eligible entry and tries to retire it. The audit
    // write throws; the transaction takes the status change down with it.
    const res = await expireDeadWaitlistEntries(new Date(), { dryRun: false });
    expect(res.eligible).toBeGreaterThanOrEqual(1);
    expect(res.expired).toBe(0);

    const after = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { status: true, expiresAt: true },
    });
    expect(after!.status).toBe("WAITING");
    expect(after!.expiresAt).toBeNull();
    expect(await prisma.waitlistEvent.count({ where: { entryId } })).toBe(0);
  });

  it("the sweep survives it - the failure is per-entry, not fatal", async () => {
    // Same call again: it returns a result rather than rejecting, which is
    // what keeps one broken row from stopping every other shop's sweep.
    await expect(
      expireDeadWaitlistEntries(new Date(), { dryRun: false }),
    ).resolves.toMatchObject({ expired: 0 });
  });
});
