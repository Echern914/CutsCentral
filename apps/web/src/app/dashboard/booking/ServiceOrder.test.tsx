import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";

/**
 * Moving a service up and down in the Services tab (Snow: "an ability to move
 * services up and down so retyping them doesn't get a lil crazy").
 *
 * 🔴 The list shows the new order only once the API has saved it. A failed
 * save leaves every row where it was and says so - never a row that moved on
 * screen and not on the booking page.
 */
const a = vi.hoisted(() => ({ reorderServicesAction: vi.fn() }));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
  listTargetedSlotsAction: vi.fn(async () => ({ ok: true, slots: [], rules: [] })),
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listSpecialDaysAction: vi.fn(async () => ({ ok: true, specialDays: [] })),
  listUpgradeRulesAction: vi.fn(async () => ({ ok: true, rules: [] })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [
  { id: "st1", name: "Snow", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];
function service(id: string, name: string, over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    durationMin: 30,
    price: 30,
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
const MENU = [
  service("cut", "Haircut"),
  service("beard", "Beard"),
  service("kids", "Kids Cut"),
  service("old", "Retired", { active: false }),
];

function renderTab(initial: ServiceRow[] = MENU) {
  const toast = vi.fn();
  render(
    <ServicesTab
      initial={initial}
      staff={staff}
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

/** The names in the reorder list, top to bottom. */
function order(): string[] {
  return screen.getAllByTestId("service-order-name").map((el) => el.textContent ?? "");
}

beforeEach(() => {
  a.reorderServicesAction.mockReset();
});

describe("Services tab: move a service up or down", () => {
  it("Move up saves the whole order and the list moves once it is saved", async () => {
    let resolve!: (v: { ok: boolean; ids?: string[] }) => void;
    a.reorderServicesAction.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    expect(order()).toEqual(["Haircut", "Beard", "Kids Cut"]);

    fireEvent.click(screen.getByRole("button", { name: "Move Beard up" }));
    // Every ACTIVE service, in the new order - the retired one is not sent.
    expect(a.reorderServicesAction).toHaveBeenCalledWith(["beard", "cut", "kids"]);
    // Not saved yet: nothing has moved, and nothing else can be moved.
    expect(order()).toEqual(["Haircut", "Beard", "Kids Cut"]);
    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Kids Cut up" })).toHaveProperty("disabled", true);

    await act(async () => resolve({ ok: true, ids: ["beard", "cut", "kids"] }));
    expect(order()).toEqual(["Beard", "Haircut", "Kids Cut"]);
    expect(screen.getByText("Beard moved to position 1 of 3.")).toBeTruthy();
  });

  it("Move down works, and the ends can't move off the list", async () => {
    a.reorderServicesAction.mockResolvedValue({ ok: true, ids: ["beard", "cut", "kids"] });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    expect(screen.getByRole("button", { name: "Move Haircut up" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Move Kids Cut down" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Move Haircut down" }));
    expect(a.reorderServicesAction).toHaveBeenCalledWith(["beard", "cut", "kids"]);
    await waitFor(() => expect(order()).toEqual(["Beard", "Haircut", "Kids Cut"]));
  });

  it("🔴 a failed save leaves the order where it was and says so", async () => {
    a.reorderServicesAction.mockResolvedValue({ ok: false, error: "http_500" });
    const { toast } = renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Kids Cut up" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't save the new order/));
    expect(order()).toEqual(["Haircut", "Beard", "Kids Cut"]);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Couldn't save the new order/), "error");
  });

  it("a stale list (services changed elsewhere) asks for a refresh", async () => {
    a.reorderServicesAction.mockResolvedValue({ ok: false, error: "incomplete_list" });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Beard down" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Refresh the page/));
    expect(order()).toEqual(["Haircut", "Beard", "Kids Cut"]);
  });

  it("dragging a row by its handle saves the dropped order", async () => {
    a.reorderServicesAction.mockResolvedValue({ ok: true, ids: ["kids", "cut", "beard"] });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    const rows = screen.getAllByTestId("service-order-row");
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(a.reorderServicesAction).toHaveBeenCalledWith(["kids", "cut", "beard"]);
    await waitFor(() => expect(order()).toEqual(["Kids Cut", "Haircut", "Beard"]));
  });

  it("Done returns to the service cards, in the saved order", async () => {
    a.reorderServicesAction.mockResolvedValue({ ok: true, ids: ["kids", "cut", "beard"] });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Reorder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Kids Cut up" }));
    await waitFor(() => expect(a.reorderServicesAction).toHaveBeenCalled());
    // The mock answers with its own order: the list follows the SERVER's answer.
    await waitFor(() => expect(order()).toEqual(["Kids Cut", "Haircut", "Beard"]));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryAllByTestId("service-order-row")).toHaveLength(0);
    const edits = screen.getAllByRole("button", { name: /^Edit / }).map((b) => b.getAttribute("aria-label"));
    expect(edits).toEqual(["Edit Kids Cut", "Edit Haircut", "Edit Beard"]);
  });

  it("no Reorder button with fewer than two services", () => {
    renderTab([service("cut", "Haircut")]);
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
  });
});
