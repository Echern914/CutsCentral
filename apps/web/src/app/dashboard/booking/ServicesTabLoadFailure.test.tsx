import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";
import type { TargetedSlotRow } from "./actions";

/**
 * Cards on the Services tab that read their own data must never go blank.
 *
 * Drick, 2026-10-20: the Targeted slots card showed only its publish form - no
 * list, no "No targeted slots yet" - while his 86 slots were live on his
 * booking page. The read had failed (most likely a page left open across a
 * website deploy) and the card had no state for that, so it sat at "not loaded
 * yet" forever.
 */

const a = vi.hoisted(() => ({
  listTargetedSlotsAction: vi.fn(),
  listUpgradeRulesAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listSpecialDaysAction: vi.fn(async () => ({ ok: true, specialDays: [] })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
const reload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reloadPage", () => ({ reloadPage: reload }));

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [
  { id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];
const RETWIST: ServiceRow = {
  id: "retwist",
  name: "Retwist",
  description: null,
  imageUrl: null,
  durationMin: 60,
  price: 40,
  priceOverrides: {},
  dateOverrides: {},
  durationOverrides: {},
  dailyLimits: {},
  hoursWindows: {},
  timeOverrides: [],
  color: null,
  offeredByAll: true,
  active: true,
  visibility: "public",
  sortOrder: 0,
  dailyTarget: null,
  staffIds: ["st1"],
  serviceGroupId: null,
};
const SLOT: TargetedSlotRow = {
  id: "t1",
  staffId: "st1",
  serviceId: "retwist",
  serviceIds: ["retwist"],
  label: "Model rate",
  startsAt: "2099-01-06T02:00:00.000Z",
  durationMin: 60,
  price: 25,
  active: true,
  ruleId: null,
  booked: false,
};

function renderTab() {
  render(
    <ServicesTab
      initial={[RETWIST]}
      staff={staff}
      initialServiceGroups={[]}
      initialAddOns={[]}
      timezone="America/New_York"
      toast={vi.fn()}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
    />,
  );
}

const LIVE_NOTE = "Your targeted slots are still live on your booking page.";

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [SLOT], rules: [] });
  a.listUpgradeRulesAction.mockResolvedValue({ ok: true, rules: [] });
  reload.mockReset();
});

describe("Targeted slots card", () => {
  it("a successful read shows the list, with no error line", async () => {
    renderTab();
    expect(await screen.findByText("Model rate")).toBeTruthy();
    expect(screen.queryByText(/Couldn.t load your targeted slots/)).toBeNull();
    expect(screen.queryByText("Loading your targeted slots…")).toBeNull();
  });

  it("says it is loading while the first read runs", async () => {
    let answer: (v: unknown) => void = () => {};
    a.listTargetedSlotsAction.mockReturnValue(new Promise((r) => (answer = r)));
    renderTab();
    expect(await screen.findByText("Loading your targeted slots…")).toBeTruthy();
    answer({ ok: true, slots: [], rules: [] });
    expect(await screen.findByText("No targeted slots yet.")).toBeTruthy();
    expect(screen.queryByText("Loading your targeted slots…")).toBeNull();
  });

  it("🔴 a failed read says so and reassures; Try again reads again and shows the list", async () => {
    a.listTargetedSlotsAction.mockResolvedValueOnce({ ok: false });
    renderTab();
    expect(await screen.findByText(/Couldn.t load your targeted slots\./)).toBeTruthy();
    expect(screen.getByText(LIVE_NOTE)).toBeTruthy();
    // Never the answer "you have none".
    expect(screen.queryByText("No targeted slots yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Model rate")).toBeTruthy();
    expect(a.listTargetedSlotsAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn.t load your targeted slots/)).toBeNull();
    expect(screen.queryByText(LIVE_NOTE)).toBeNull();
  });

  it("a read that throws (no answer at all) is a failure too, not a blank card", async () => {
    a.listTargetedSlotsAction.mockRejectedValueOnce(new TypeError("Load failed"));
    renderTab();
    expect(await screen.findByText(/Couldn.t load your targeted slots\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("🔴 a page left open across a deploy says ChairBack was updated, and Reload reloads", async () => {
    // What Next 14.2 hands back for a server action the new build doesn't
    // have: no throw, just undefined (lib/loadAction.ts).
    a.listTargetedSlotsAction.mockResolvedValueOnce(undefined);
    renderTab();
    expect(await screen.findByText(/ChairBack was updated/)).toBeTruthy();
    expect(screen.getByText(LIVE_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("Upgrade prompts card", () => {
  it("🔴 a failed read is not 'Nothing set up'", async () => {
    a.listUpgradeRulesAction.mockResolvedValueOnce({ ok: false });
    renderTab();
    expect(await screen.findByText(/Couldn.t load your upgrade prompts\./)).toBeTruthy();
    expect(screen.queryByText(/Nothing set up/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Nothing set up/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Couldn.t load your upgrade prompts/)).toBeNull());
  });
});
