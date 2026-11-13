import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceGroupRow, ServiceRow, StaffRow } from "./page";

/**
 * Services used to be one long page: the add form, the list, upgrade prompts,
 * groups, holiday pricing, special days, add-ons and targeted slots, each
 * under the last. A barber looking for a price scrolled past all of it.
 *
 * It is now three sections - Menu, Special dates, Extras - and the menu is
 * what opens. Adding a service is its own sheet.
 */

const a = vi.hoisted(() => ({
  createServiceAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listSpecialDaysAction: vi.fn(async () => ({ ok: true, specialDays: [] })),
  listTargetedSlotsAction: vi.fn(async () => ({ ok: true, slots: [], rules: [] })),
  listUpgradeRulesAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

// The address as next/navigation sees it (same stand-in as useUrlTab.test).
let search = new URLSearchParams();
const listeners = new Set<() => void>();
function setAddress(qs: string) {
  search = new URLSearchParams(qs);
  window.history.replaceState(null, "", `/dashboard/booking${qs ? `?${qs}` : ""}`);
  listeners.forEach((l) => l());
}
vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    useSearchParams: () => {
      const [, bump] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        listeners.add(bump);
        return () => {
          listeners.delete(bump);
        };
      }, []);
      return search;
    },
  };
});

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [
  { id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];

function service(id: string, name: string, over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    durationMin: 30,
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

function group(id: string, name: string, serviceIds: string[], sortOrder: number): ServiceGroupRow {
  return { id, name, maxPerDay: null, maxConcurrent: null, dailyTarget: null, active: true, sortOrder, serviceIds };
}

function renderTab(services: ServiceRow[] = [service("fade", "Fade")], groups: ServiceGroupRow[] = []) {
  const toast = vi.fn();
  render(
    <ServicesTab
      initial={services}
      staff={staff}
      initialServiceGroups={groups}
      initialAddOns={[]}
      timezone="America/New_York"
      toast={toast}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
    />,
  );
  return { toast };
}

// One control from each section: on screen means its section is the one shown.
const onMenu = () => screen.queryByRole("button", { name: "Add service" });
const onDates = () => screen.queryByRole("button", { name: "Add a date" });
const onExtras = () => screen.queryByRole("button", { name: "Add add-on" });
const go = (name: "Menu" | "Special dates" | "Extras") =>
  fireEvent.click(
    within(screen.getByRole("group", { name: "Services sections" })).getByRole("button", { name }),
  );

beforeEach(() => {
  a.createServiceAction.mockReset();
  a.createServiceAction.mockResolvedValue({ ok: true });
  search = new URLSearchParams();
  listeners.clear();
  window.history.replaceState(null, "", "/dashboard/booking?tab=Services");
});

describe("Services opens as a menu", () => {
  it("🔴 the menu is shown alone: special dates and extras are a tap away, not under it", () => {
    renderTab();
    expect(onMenu()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit Fade" })).toBeTruthy();
    expect(onDates()).toBeNull();
    expect(onExtras()).toBeNull();
  });

  it("Special dates shows the days that run differently, and only those", () => {
    renderTab();
    go("Special dates");
    expect(onDates()).not.toBeNull();
    expect(onMenu()).toBeNull();
    expect(onExtras()).toBeNull();
  });

  it("Extras shows add-ons, and only the extras", () => {
    renderTab();
    go("Extras");
    expect(onExtras()).not.toBeNull();
    expect(onMenu()).toBeNull();
    expect(onDates()).toBeNull();
  });

  it("the control says which section is open", () => {
    renderTab();
    const pressed = () =>
      within(screen.getByRole("group", { name: "Services sections" }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent);
    expect(pressed()).toEqual(["Menu"]);
    go("Extras");
    expect(pressed()).toEqual(["Extras"]);
  });

  it("🔴 a half-typed add-on is still there after a look at the menu", () => {
    renderTab();
    go("Extras");
    fireEvent.change(screen.getByPlaceholderText("e.g. Beard trim"), { target: { value: "Hot towel" } });
    go("Menu");
    go("Extras");
    expect(screen.getByPlaceholderText("e.g. Beard trim")).toHaveValue("Hot towel");
  });
});

describe("the address names the section", () => {
  it("?section=extras opens on Extras", () => {
    setAddress("tab=Services&section=extras");
    renderTab();
    expect(onExtras()).not.toBeNull();
    expect(onMenu()).toBeNull();
  });

  it("a section that is not one of ours opens the menu", () => {
    setAddress("tab=Services&section=addons");
    renderTab();
    expect(onMenu()).not.toBeNull();
  });

  it("🔴 a link to another section while Services is already open switches to it", () => {
    renderTab();
    expect(onMenu()).not.toBeNull();
    act(() => setAddress("tab=Services&section=dates"));
    expect(onDates()).not.toBeNull();
    expect(onMenu()).toBeNull();
  });

  it("the address follows the control, and keeps the tab", () => {
    renderTab();
    go("Extras");
    const now = new URLSearchParams(window.location.search);
    expect(now.get("section")).toBe("extras");
    expect(now.get("tab")).toBe("Services");
  });
});

describe("the menu reads the way the booking page does", () => {
  const services = [
    service("kids", "Kids cut"),
    service("fade", "Fade"),
    service("beard", "Beard"),
    service("first", "First visit"),
  ];
  const groups = [group("g2", "New clients", ["first"], 1), group("g1", "Regulars", ["beard", "fade"], 0)];

  const headings = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  const under = (heading: string) => {
    const h = screen.getByRole("heading", { level: 3, name: heading });
    return within(h.parentElement as HTMLElement)
      .getAllByRole("button", { name: /^Edit / })
      .map((b) => b.getAttribute("aria-label"));
  };

  it("🔴 groups head their services, in group order; the rest go under More services", () => {
    renderTab(services, groups);
    expect(headings()).toEqual(["Regulars", "New clients", "More services"]);
    // In the order the group saved, not the order of the shop list.
    expect(under("Regulars")).toEqual(["Edit Beard", "Edit Fade"]);
    expect(under("New clients")).toEqual(["Edit First visit"]);
    expect(under("More services")).toEqual(["Edit Kids cut"]);
  });

  it("every service is listed once", () => {
    renderTab(services, groups);
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(services.length);
  });

  it("a shop with no groups gets the plain list, with no headings", () => {
    renderTab(services, []);
    expect(screen.queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(
      screen.getAllByRole("button", { name: /^Edit / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Edit Kids cut", "Edit Fade", "Edit Beard", "Edit First visit"]);
  });
});

describe("Add a service", () => {
  const sheet = () => within(screen.getByRole("dialog", { name: "Add a service" }));
  const nameBox = () => sheet().getByRole("textbox", { name: "Service name" });
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Add service" }));
  const submit = () => fireEvent.click(sheet().getByRole("button", { name: "Add to menu" }));

  it("is its own sheet, closed until asked for", () => {
    renderTab();
    expect(screen.queryByRole("dialog", { name: "Add a service" })).toBeNull();
    open();
    expect(nameBox()).toBeTruthy();
  });

  it("a saved service closes the sheet, says so, and starts the next one blank", async () => {
    const { toast } = renderTab();
    open();
    fireEvent.change(nameBox(), { target: { value: "Line up" } });
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a service" })).toBeNull());
    expect(a.createServiceAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Line up", offeredByAll: true }),
    );
    expect(toast).toHaveBeenCalledWith("Service added", "success");
    open();
    expect(nameBox()).toHaveValue("");
  });

  it("🔴 a refused add is said in the sheet, which stays open with what was typed", async () => {
    a.createServiceAction.mockResolvedValue({ ok: false, error: "bad_request" });
    const { toast } = renderTab();
    open();
    fireEvent.change(nameBox(), { target: { value: "Line up" } });
    submit();
    expect(await sheet().findByRole("alert")).toHaveTextContent(
      "Couldn't add this service. Nothing was added - check the details and try again.",
    );
    expect(nameBox()).toHaveValue("Line up");
    // Not a toast: on a phone it is drawn behind the open sheet.
    expect(toast).not.toHaveBeenCalled();
  });

  it("no connection reads as no connection", async () => {
    a.createServiceAction.mockResolvedValue({ ok: false, error: "network_error" });
    renderTab();
    open();
    fireEvent.change(nameBox(), { target: { value: "Line up" } });
    submit();
    expect(await sheet().findByRole("alert")).toHaveTextContent("Couldn't connect.");
  });

  it("a missing name is asked for, and nothing is sent", () => {
    renderTab();
    open();
    submit();
    expect(sheet().getByRole("alert")).toHaveTextContent("Give the service a name.");
    expect(a.createServiceAction).not.toHaveBeenCalled();
  });

  it("🔴 closing the sheet by accident keeps what was typed, and clears an old error", () => {
    renderTab();
    open();
    submit();
    expect(sheet().getByRole("alert")).toBeTruthy();
    fireEvent.change(nameBox(), { target: { value: "Line up" } });
    fireEvent.click(sheet().getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Add a service" })).toBeNull();
    open();
    expect(nameBox()).toHaveValue("Line up");
    expect(sheet().queryByRole("alert")).toBeNull();
  });
});
