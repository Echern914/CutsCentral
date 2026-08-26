import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
vi.mock("./api", () => ({ apiGet: (path: string) => apiGet(path) }));

const { collectNotificationSignals } = await import("./notificationSignals");

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const denied = (status: number) => ({ ok: false, status, data: null, error: "nope" });

/** Route each request by path so tests declare only what they care about. */
function routes(map: Record<string, unknown>) {
  apiGet.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([frag]) => path.includes(frag));
    return Promise.resolve(hit ? hit[1] : denied(404));
  });
}

const MANAGER = { barberOnly: false, premiumAiLocked: false };

beforeEach(() => {
  apiGet.mockReset();
});

describe("collectNotificationSignals", () => {
  it("lists every source that has something outstanding", async () => {
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 2 }),
      waitlist: ok({ counts: { WAITING: 3 } }),
      conversations: ok({ escalatedCount: 1 }),
    });
    const out = await collectNotificationSignals(MANAGER);
    expect(out.map((s) => s.key)).toEqual(["readiness", "waitlist", "inbox"]);
    expect(out.reduce((n, s) => n + s.count, 0)).toBe(6);
  });

  it("drops a source with nothing outstanding rather than listing a zero", async () => {
    // A bell that opens onto "0 waiting, 0 to reply" teaches you to ignore it.
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 0 }),
      waitlist: ok({ counts: { WAITING: 0 } }),
      conversations: ok({ escalatedCount: 2 }),
    });
    const out = await collectNotificationSignals(MANAGER);
    expect(out.map((s) => s.key)).toEqual(["inbox"]);
  });

  it("returns nothing at all when everything is clear", async () => {
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 0 }),
      waitlist: ok({ counts: { WAITING: 0 } }),
      conversations: ok({ escalatedCount: 0 }),
    });
    expect(await collectNotificationSignals(MANAGER)).toEqual([]);
  });

  it("stays quiet when a source is forbidden or walled", async () => {
    // 403 for an employee seat and 402 for a lapsed shop are NORMAL answers
    // here, not errors. The header must not break because a count was
    // unavailable.
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 1 }),
      waitlist: denied(403),
      conversations: denied(402),
    });
    const out = await collectNotificationSignals(MANAGER);
    expect(out.map((s) => s.key)).toEqual(["readiness"]);
  });

  it("survives every source failing", async () => {
    routes({});
    expect(await collectNotificationSignals(MANAGER)).toEqual([]);
  });

  it("never asks for the manager-only counts on an employee seat", async () => {
    routes({ readiness: ok({ scope: "barber", incompletePersonal: 2 }) });
    const out = await collectNotificationSignals({
      barberOnly: true,
      premiumAiLocked: false,
    });
    const asked = apiGet.mock.calls.map(([p]) => p as string);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("/api/readiness/summary");
    expect(out[0]!.label).toBe("2 things left to set up");
  });

  it("reads the EMPLOYEE field for an employee, not the shop one", async () => {
    // Showing a barber a shop-wide milestone count is showing them a number
    // they cannot act on.
    routes({
      readiness: ok({ scope: "barber", incompletePersonal: 1, milestonesBlocking: 9 }),
    });
    const out = await collectNotificationSignals({
      barberOnly: true,
      premiumAiLocked: false,
    });
    expect(out[0]!.count).toBe(1);
  });

  it("skips the receptionist inbox when premium AI is locked", async () => {
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 0 }),
      waitlist: ok({ counts: { WAITING: 1 } }),
    });
    await collectNotificationSignals({ barberOnly: false, premiumAiLocked: true });
    const asked = apiGet.mock.calls.map(([p]) => p as string);
    expect(asked.some((p) => p.includes("conversations"))).toBe(false);
  });

  it("pluralises each label", async () => {
    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 1 }),
      waitlist: ok({ counts: { WAITING: 1 } }),
      conversations: ok({ escalatedCount: 1 }),
    });
    const one = await collectNotificationSignals(MANAGER);
    expect(one.map((s) => s.label)).toEqual([
      "1 step before you can go live",
      "1 person waiting",
      "1 conversation needs a reply",
    ]);

    routes({
      readiness: ok({ scope: "shop", milestonesBlocking: 2 }),
      waitlist: ok({ counts: { WAITING: 2 } }),
      conversations: ok({ escalatedCount: 2 }),
    });
    const many = await collectNotificationSignals(MANAGER);
    expect(many.map((s) => s.label)).toEqual([
      "2 steps before you can go live",
      "2 people waiting",
      "2 conversations need a reply",
    ]);
  });

  it("tolerates a payload missing the count field entirely", async () => {
    // An older API deploy, or a shape change. Absent must read as zero, never
    // as NaN in the badge.
    routes({
      readiness: ok({ scope: "shop" }),
      waitlist: ok({}),
      conversations: ok({}),
    });
    expect(await collectNotificationSignals(MANAGER)).toEqual([]);
  });
});
