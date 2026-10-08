import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";
import type { TargetedSlotRow, TargetedSlotRuleRow } from "./actions";

/**
 * Services tab mishaps found by the 2026-10-08 sweep. Each compiled, looked
 * fine in a desktop click-through, and did something the barber didn't ask:
 *
 *  - editing a series dropped the "Also bookable as" change, then said "Series
 *    updated";
 *  - clearing a special's price box published it FREE (Number("") is 0);
 *  - one tap on Turn off / Remove series ended a series for good;
 *  - Duplicate put a HIDDEN service's copy on the booking page, without its
 *    daily caps or holiday prices;
 *  - one tap on staff Remove took a barber off booking with no way back.
 */

const a = vi.hoisted(() => ({
  listTargetedSlotsAction: vi.fn(),
  updateTargetedSlotRuleAction: vi.fn(),
  updateTargetedSlotAction: vi.fn(),
  deleteTargetedSlotRuleAction: vi.fn(),
  createServiceAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listUpgradeRulesAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [
  { id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];
function service(over: Partial<ServiceRow>): ServiceRow {
  return {
    id: "svc1",
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
    ...over,
  };
}
const RETWIST = service({ id: "retwist", name: "Retwist" });
const BRAIDS = service({ id: "braids", name: "Braids" });

const RULE: TargetedSlotRuleRow = {
  id: "r1",
  staffId: "st1",
  serviceId: "retwist",
  serviceIds: ["retwist"],
  label: "Late night",
  schedule: { "2": [{ startMin: 1260 }] },
  durationMin: 60,
  price: 12.5,
  indefinite: true,
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

/** The series or slot card whose title is `title` (its <li>). */
async function card(title: string) {
  return within((await screen.findByText(title)).closest("li") as HTMLElement);
}

function renderTab(initial: ServiceRow[] = [RETWIST, BRAIDS], staffRows = staff) {
  const toast = vi.fn();
  render(
    <ServicesTab
      initial={initial}
      staff={staffRows}
      initialServiceGroups={[]}
      initialAddOns={[]}
      timezone="America/New_York"
      toast={toast}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
    />,
  );
  return { toast };
}

const confirmSpy = vi.spyOn(window, "confirm");
beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [SLOT], rules: [RULE] });
  a.updateTargetedSlotRuleAction.mockResolvedValue({ ok: true });
  a.updateTargetedSlotAction.mockResolvedValue({ ok: true });
  a.deleteTargetedSlotRuleAction.mockResolvedValue({ ok: true });
  a.createServiceAction.mockResolvedValue({ ok: true });
  confirmSpy.mockReset();
});
afterEach(() => confirmSpy.mockReset());

describe("targeted series and slots", () => {
  it("🔴 editing a series sends the 'Also bookable as' set it shows", async () => {
    renderTab();
    (await card("Late night")).getByRole("button", { name: "Edit" }).click();
    const chips = within(await screen.findByRole("group", { name: "Other services this slot is bookable as" }));
    fireEvent.click(chips.getByRole("button", { name: /Braids/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(a.updateTargetedSlotRuleAction).toHaveBeenCalledTimes(1));
    expect(a.updateTargetedSlotRuleAction.mock.calls[0]![1]).toMatchObject({
      serviceIds: ["retwist", "braids"],
    });
  });

  it("a draft copy's save button says Publish, as its toast promised", async () => {
    a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [], rules: [{ ...RULE, draft: true }] });
    renderTab();
    (await card("Late night")).getByRole("button", { name: "Edit" }).click();
    expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("🔴 Turn off asks first, and a No leaves the series alone", async () => {
    renderTab();
    confirmSpy.mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toMatch(/can't be turned back on/);
    expect(a.deleteTargetedSlotRuleAction).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(a.deleteTargetedSlotRuleAction).toHaveBeenCalledWith("r1"));
  });

  it("🔴 a cleared price on a special is refused, never saved as $0", async () => {
    const { toast } = renderTab();
    const slot = await card("Model rate");
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    const priceBox = (await slot.findByDisplayValue("25")) as HTMLInputElement;
    fireEvent.change(priceBox, { target: { value: "" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(a.updateTargetedSlotAction).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Enter a price", "error");
  });

  it("cards show cents: a $12.50 series is not $13", async () => {
    renderTab();
    const series = await card("Late night");
    // The card's own disclosure button is the one that opens its dates.
    fireEvent.click(series.getAllByRole("button", { expanded: false })[0]!);
    expect(await screen.findByText(/\$12\.50/)).toBeTruthy();
    expect(screen.queryByText(/\$13\b/)).toBeNull();
  });
});

describe("Duplicate keeps what the service is", () => {
  it("🔴 a hidden service's copy stays hidden, with its daily caps and holiday prices", async () => {
    const secret = service({
      id: "vip",
      name: "VIP cut",
      visibility: "hidden",
      dailyLimits: { "5": 2 },
      dateOverrides: { "2099-12-24": 80 },
    });
    renderTab([secret]);
    fireEvent.click(await screen.findByRole("button", { name: /Duplicate VIP cut/i }));
    await waitFor(() => expect(a.createServiceAction).toHaveBeenCalledTimes(1));
    expect(a.createServiceAction.mock.calls[0]![0]).toMatchObject({
      name: "VIP cut copy",
      visibility: "hidden",
      dailyLimits: { "5": 2 },
      dateOverrides: { "2099-12-24": 80 },
    });
  });

  it("a public service's copy is public", async () => {
    renderTab([RETWIST]);
    fireEvent.click(await screen.findByRole("button", { name: /Duplicate Retwist/i }));
    await waitFor(() => expect(a.createServiceAction).toHaveBeenCalledTimes(1));
    expect(a.createServiceAction.mock.calls[0]![0]).toMatchObject({ visibility: "public" });
  });
});
