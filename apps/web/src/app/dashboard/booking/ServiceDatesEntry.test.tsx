import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";

/**
 * "Dates" on a service card - the way into Change some days.
 *
 * The sheet itself is tested on its own (ServiceDatesSheet.test.tsx). This
 * pins the wiring a barber would notice:
 *   - the button says how many dated days are still ahead, and ignores ones
 *     gone by;
 *   - it opens THAT service's sheet;
 *   - after a save the card's count and a reopened sheet show the new day
 *     at once, without waiting for the page to refetch (which takes seconds
 *     in production and used to read as "it didn't save").
 *
 * The clock is pinned to Thu 12 Nov 2026 in the shop's timezone.
 */
const setServiceDateHoursAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  setServiceDateHoursAction,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [], recurringBlocks: [], exceptions: [] } })),
  listSpecialDaysAction: vi.fn(async () => ({ ok: true, specialDays: [] })),
  listTargetedSlotsAction: vi.fn(async () => ({ ok: false })),
  listUpgradeRulesAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [{ id: "st1", name: "Avery", bio: null, imageUrl: null, active: true, sortOrder: 0 }];

function service(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "svc1",
    name: "Haircut",
    description: null,
    imageUrl: null,
    durationMin: 30,
    price: 45,
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
    ...over,
  } as ServiceRow;
}

function tab(initial: ServiceRow[]) {
  return render(
    <ServicesTab
      initial={initial}
      staff={staff}
      initialServiceGroups={[]}
      initialAddOns={[]}
      timezone="UTC"
      toast={vi.fn()}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00.000Z"));
  setServiceDateHoursAction.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Dates on a service card", () => {
  it("counts the dated days still ahead, and not the ones gone by", () => {
    tab([
      service({
        dateHours: {
          "2026-11-10": { w: [], staff: [] }, // already passed
          "2026-11-12": { w: [{ s: 480, e: 600 }], staff: [] }, // today still counts
          "2026-11-23": { w: [{ s: 480, e: 600 }], staff: [] },
        },
      }),
      service({ id: "svc2", name: "Retwist" }),
    ]);
    expect(screen.getByRole("button", { name: "Change some days for Haircut" }).textContent).toBe("Dates (2)");
    expect(screen.getByRole("button", { name: "Change some days for Retwist" }).textContent).toBe("Dates");
  });

  it("opens that service's sheet", () => {
    tab([service(), service({ id: "svc2", name: "Retwist" })]);
    fireEvent.click(screen.getByRole("button", { name: "Change some days for Retwist" }));
    expect(screen.getByRole("dialog", { name: "Retwist: change some days" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Haircut: change some days" })).toBeNull();
  });

  it("a save shows on the card and in a reopened sheet before the page refetches", async () => {
    const stored = { "2026-11-13": { w: [{ s: 540, e: 1020 }], staff: [] } };
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: stored, dateOverrides: {} });
    tab([service()]);
    fireEvent.click(screen.getByRole("button", { name: "Change some days for Haircut" }));
    const sheet = () => within(screen.getByRole("dialog", { name: "Haircut: change some days" }));
    fireEvent.click(sheet().getByRole("button", { name: /^Fri Nov 13/ }));
    fireEvent.click(sheet().getByRole("button", { name: "Save 1 day" }));
    await waitFor(() => expect(sheet().getByRole("status").textContent).toMatch(/^Saved\./));
    expect(setServiceDateHoursAction).toHaveBeenCalledWith("svc1", {
      dates: ["2026-11-13"],
      hours: [{ s: 540, e: 1020 }],
    });

    // Close, and the card already knows - `initial` has NOT changed.
    fireEvent.click(sheet().getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Haircut: change some days" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change some days for Haircut" }).textContent).toBe("Dates (1)");

    // Reopened: the day is listed.
    fireEvent.click(screen.getByRole("button", { name: "Change some days for Haircut" }));
    const list = sheet().getByRole("region", { name: "Days already changed" });
    expect(within(list).getByText("Fri Nov 13")).toBeTruthy();
  });
});
