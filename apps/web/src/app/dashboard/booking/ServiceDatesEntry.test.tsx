import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";

/**
 * "Special dates" on a service's page - the way into Change some days.
 *
 * The sheet itself is tested on its own (ServiceDatesSheet.test.tsx). This
 * pins the wiring a barber would notice:
 *   - the menu card and the page's row say how many dated days are still
 *     ahead, and ignore ones gone by;
 *   - the row opens THAT service's sheet, and Done comes back to the page
 *     with everything typed on it still there;
 *   - after a save the count and a reopened sheet show the new day at once,
 *     without waiting for the page to refetch (which takes seconds in
 *     production and used to read as "it didn't save");
 *   - a price the sheet set is not written back over by the page's own Save.
 *
 * The clock is pinned to Thu 12 Nov 2026 in the shop's timezone.
 */
const a = vi.hoisted(() => ({
  setServiceDateHoursAction: vi.fn(),
  updateServiceAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
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

const page = () => within(screen.getByRole("dialog", { name: "Edit service" }));
const openPage = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
const datesRow = () => page().getByRole("button", { name: /^Special dates/ });
const datesSheet = (name: string) => within(screen.getByRole("dialog", { name: `${name}: change some days` }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00.000Z"));
  a.setServiceDateHoursAction.mockReset();
  a.updateServiceAction.mockReset();
  a.updateServiceAction.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Special dates on a service", () => {
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
    // On the menu, before anything is opened.
    expect(within(screen.getByRole("button", { name: "Edit Haircut" })).getByText("2 special dates")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Edit Retwist" })).queryByText(/special date/)).toBeNull();
    // And on the service's page.
    openPage("Haircut");
    expect(datesRow()).toHaveTextContent("2 coming up");
  });

  it("one day ahead is one date, not one dates", () => {
    tab([service({ dateHours: { "2026-11-23": { w: [{ s: 480, e: 600 }], staff: [] } } })]);
    expect(within(screen.getByRole("button", { name: "Edit Haircut" })).getByText("1 special date")).toBeTruthy();
  });

  it("a service with none says so", () => {
    tab([service()]);
    openPage("Haircut");
    expect(datesRow()).toHaveTextContent("None");
  });

  it("opens that service's sheet", () => {
    tab([service(), service({ id: "svc2", name: "Retwist" })]);
    openPage("Retwist");
    fireEvent.click(datesRow());
    expect(screen.getByRole("dialog", { name: "Retwist: change some days" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Haircut: change some days" })).toBeNull();
  });

  it("🔴 Done comes back to the page, with what was typed there still on it", () => {
    tab([service()]);
    openPage("Haircut");
    fireEvent.change(page().getByRole("textbox", { name: "Service name" }), { target: { value: "Haircut and line up" } });
    fireEvent.click(datesRow());
    expect(screen.queryByRole("dialog", { name: "Edit service" })).toBeNull();
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: "Close" }));
    expect(page().getByRole("textbox", { name: "Service name" })).toHaveValue("Haircut and line up");
  });

  it("a save shows on the page, on the card and in a reopened sheet before the page refetches", async () => {
    const stored = { "2026-11-13": { w: [{ s: 540, e: 1020 }], staff: [] } };
    a.setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: stored, dateOverrides: {} });
    tab([service()]);
    openPage("Haircut");
    fireEvent.click(datesRow());
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: /^Fri Nov 13/ }));
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: "Save 1 day" }));
    await waitFor(() => expect(datesSheet("Haircut").getByRole("status").textContent).toMatch(/^Saved\./));
    expect(a.setServiceDateHoursAction).toHaveBeenCalledWith("svc1", {
      dates: ["2026-11-13"],
      hours: [{ s: 540, e: 1020 }],
    });

    // Done, and the page already knows - `initial` has NOT changed.
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Haircut: change some days" })).toBeNull();
    expect(datesRow()).toHaveTextContent("1 coming up");

    // So does the menu card behind it.
    fireEvent.click(page().getByRole("button", { name: "Close" }));
    expect(within(screen.getByRole("button", { name: "Edit Haircut" })).getByText("1 special date")).toBeTruthy();

    // Reopened: the day is listed.
    openPage("Haircut");
    fireEvent.click(datesRow());
    const list = datesSheet("Haircut").getByRole("region", { name: "Days already changed" });
    expect(within(list).getByText("Fri Nov 13")).toBeTruthy();
  });

  it("🔴 a price the dates sheet just set is not written back over by the page's Save", async () => {
    // The page's Save sends the WHOLE map of dated prices. It opened holding
    // an empty one; if it kept that, saving a new name would erase the price.
    a.setServiceDateHoursAction.mockResolvedValue({
      ok: true,
      dateHours: { "2026-11-13": { w: [{ s: 540, e: 1020 }], staff: [] } },
      dateOverrides: { "2026-11-13": 60 },
    });
    tab([service()]);
    openPage("Haircut");
    fireEvent.click(datesRow());
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: /^Fri Nov 13/ }));
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: "Save 1 day" }));
    await waitFor(() => expect(datesSheet("Haircut").getByRole("status").textContent).toMatch(/^Saved\./));
    fireEvent.click(datesSheet("Haircut").getByRole("button", { name: "Done" }));

    expect(page().getByRole("button", { name: /^On one date/ })).toHaveTextContent("Nov 13 $60");
    fireEvent.click(page().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(a.updateServiceAction).toHaveBeenCalledTimes(1));
    expect(a.updateServiceAction.mock.calls[0]![1]).toMatchObject({ dateOverrides: { "2026-11-13": 60 } });
  });
});
