import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceGroupRow, ServiceRow, StaffRow } from "./page";

/**
 * "SOMETIMES I SAVE THINGS IN THE SERVICES AND THEY DON'T SAVE." (a barber,
 * 2026-10-01)
 *
 * Two ways the Edit service sheet lost a barber's work:
 *
 *  1. Every refusal - his own typo, or the server saying no - was a TOAST, and
 *     the toast layer draws beneath this sheet. On a phone Save looked dead;
 *     he closed the sheet and the edit was gone. (The appointment edit sheet
 *     had the identical bug, fixed in #468.)
 *  2. After a save the list holds the PRE-save row for the seconds the page
 *     refresh takes. Reopening the service in that window showed the old
 *     values - "it didn't save" - and because a save sends the WHOLE service,
 *     saving again from there wrote the old values back over the new ones.
 *
 * Pinned: a refusal is read in the sheet, directly above Save, naming the part
 * to fix, with the sheet still open and nothing toasted; a dropped connection
 * says so; a good save hands back exactly what it wrote; and that row is what
 * the list and the next open show until the refreshed list arrives - after
 * which the server's row wins again.
 */

const updateServiceAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  updateServiceAction,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  // What the tab's other panels load on mount - irrelevant here.
  listTargetedSlotsAction: vi.fn(async () => ({ ok: false })),
  listUpgradeRulesAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServiceEditForm, ServicesTab, serviceSaveRefusal } = await import("./BookingManager");
const { useJustSaved } = await import("./justSaved");

const staff: StaffRow[] = [
  { id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];

function service(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "svc1",
    name: "Retwist",
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

function openEditor(row = service()) {
  const toast = vi.fn();
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ServiceEditForm
      service={row}
      services={[row]}
      staff={staff}
      groupName={null}
      toast={toast}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { toast, onClose, onSaved, save: () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })) };
}

beforeEach(() => {
  updateServiceAction.mockReset();
});

describe("🔴 a save that doesn't go through is said in the sheet, above Save", () => {
  it("a server refusal names the part to fix, keeps the sheet open, and toasts nothing", async () => {
    updateServiceAction.mockResolvedValue({ ok: false, error: "invalid_input", field: "timeOverrides" });
    const { toast, onClose, onSaved, save } = openEditor();
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save - check the time windows. Nothing was changed.");
    // Directly above the button he just pressed.
    expect(alert.nextElementSibling).toBe(screen.getByRole("button", { name: "Save changes" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a value the sheet refuses itself is said there too, and nothing is sent", async () => {
    const { toast, save } = openEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Service name" }), { target: { value: "  " } });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required");
    expect(updateServiceAction).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a lost connection is said, not swallowed", async () => {
    updateServiceAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const { onClose, save } = openEditor();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't connect");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pressing Save again clears the old message first", async () => {
    updateServiceAction.mockResolvedValueOnce({ ok: false, error: "invalid_input" });
    updateServiceAction.mockResolvedValueOnce({ ok: true });
    const { onClose, save } = openEditor();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Nothing was changed - tap Save again.");
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a save that goes through", () => {
  it("hands back exactly what it wrote, then closes with a toast the barber can see", async () => {
    updateServiceAction.mockResolvedValue({ ok: true });
    const { toast, onClose, onSaved, save } = openEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Service name" }), { target: { value: "Retwist + style" } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const written = updateServiceAction.mock.calls[0]![1];
    const row = onSaved.mock.calls[0]![0] as ServiceRow;
    expect(row.id).toBe("svc1");
    expect(row.name).toBe("Retwist + style");
    expect(written.name).toBe("Retwist + style");
    expect(row.durationMin).toBe(written.durationMin);
    expect(row.price).toBe(written.price);
    expect(row.timeOverrides).toEqual([]);
    expect(toast).toHaveBeenCalledWith("Service updated", "success");
    expect(onClose).toHaveBeenCalled();
  });

  it("a reopened editor seeded from the saved row shows the saved values", () => {
    openEditor(service({ name: "Retwist + style", price: 55 }));
    expect(screen.getByRole("textbox", { name: "Service name" })).toHaveValue("Retwist + style");
  });
});

describe("🔴 the Services list right after a save, before the page refresh lands", () => {
  function tab(initial: ServiceRow[], groups: ServiceGroupRow[] = []) {
    return (
      <ServicesTab
        initial={initial}
        staff={staff}
        initialServiceGroups={groups}
        initialAddOns={[]}
        timezone="America/New_York"
        toast={vi.fn()}
        groupUnsavedRef={{ current: null }}
        acuityConnected={false}
      />
    );
  }

  /** The Edit service sheet (the tab's own Add form has a "Service name" too). */
  const sheet = () => within(screen.getByRole("dialog", { name: "Edit service" }));

  it("shows what was saved, and reopening the service edits THAT - not the old row", async () => {
    updateServiceAction.mockResolvedValue({ ok: true });
    const before = service();
    const { rerender } = render(tab([before]));
    fireEvent.click(screen.getByRole("button", { name: "Edit Retwist" }));
    fireEvent.change(sheet().getByRole("textbox", { name: "Service name" }), { target: { value: "Retwist + style" } });
    fireEvent.click(sheet().getByRole("button", { name: "Save changes" }));
    // The sheet closes; the list still holds `before` (no refresh yet).
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit service" })).toBeNull());
    // The list's card already reads what was saved...
    expect(screen.queryByRole("button", { name: "Edit Retwist" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Retwist + style" }));
    // ...and reopening it edits the saved row, so a second save can't write the old one back.
    expect(sheet().getByRole("textbox", { name: "Service name" })).toHaveValue("Retwist + style");
    fireEvent.click(sheet().getByRole("button", { name: "Close" }));

    // The refresh lands with the server's row - from then on, that is what shows.
    rerender(tab([service({ name: "Retwist + style (from the server)" })]));
    expect(screen.getByRole("button", { name: "Edit Retwist + style (from the server)" })).toBeTruthy();
  });

  it("opening it from its service group edits the saved row too", async () => {
    updateServiceAction.mockResolvedValue({ ok: true });
    const group: ServiceGroupRow = {
      id: "g1",
      name: "Locs",
      maxPerDay: null,
      maxConcurrent: null,
      dailyTarget: null,
      active: true,
      sortOrder: 0,
      serviceIds: ["svc1"],
    };
    render(tab([service({ serviceGroupId: "g1" })], [group]));
    fireEvent.click(screen.getByRole("button", { name: "Edit Retwist" }));
    fireEvent.change(sheet().getByRole("textbox", { name: "Service name" }), { target: { value: "Retwist + style" } });
    fireEvent.click(sheet().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit service" })).toBeNull());
    // The group's own list still holds the old row; opening the member from
    // there must still land on what was saved.
    fireEvent.click(screen.getByRole("button", { name: /^Locs/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Edit hours for/ }));
    expect(sheet().getByRole("textbox", { name: "Service name" })).toHaveValue("Retwist + style");
  });
});

describe("🔴 the row a save just wrote, until the refreshed list arrives (useJustSaved)", () => {
  type Row = { id: string; price: number };

  it("is what the list shows and the editor opens with, while the list still holds the old row", () => {
    const listed: Row = { id: "s1", price: 40 };
    const { result } = renderHook(() => useJustSaved<Row>());
    act(() => result.current.remember(listed, { id: "s1", price: 55 }));
    expect(result.current.current(listed).price).toBe(55);
  });

  it("gives way to the server's row the moment the refresh lands - a change made elsewhere is never masked", () => {
    const listed: Row = { id: "s1", price: 40 };
    const { result } = renderHook(() => useJustSaved<Row>());
    act(() => result.current.remember(listed, { id: "s1", price: 55 }));
    const refreshed: Row = { id: "s1", price: 55 };
    expect(result.current.current(refreshed)).toBe(refreshed);
    const changedElsewhere: Row = { id: "s1", price: 60 };
    expect(result.current.current(changedElsewhere).price).toBe(60);
  });

  it("two saves before the refresh: the second one is what shows", () => {
    const listed: Row = { id: "s1", price: 40 };
    const { result } = renderHook(() => useJustSaved<Row>());
    act(() => result.current.remember(listed, { id: "s1", price: 55 }));
    act(() => result.current.remember(listed, { id: "s1", price: 65 }));
    expect(result.current.current(listed).price).toBe(65);
  });

  it("only the saved service is affected", () => {
    const a: Row = { id: "a", price: 40 };
    const b: Row = { id: "b", price: 20 };
    const { result } = renderHook(() => useJustSaved<Row>());
    act(() => result.current.remember(a, { id: "a", price: 55 }));
    expect(result.current.current(b)).toBe(b);
  });
});

describe("serviceSaveRefusal", () => {
  it("speaks to what happened", () => {
    expect(serviceSaveRefusal({ error: "not_found" })).toBe("This service was removed. Close this and refresh the page.");
    expect(serviceSaveRefusal({ error: "invalid_input", field: "hoursWindows" })).toBe(
      "Couldn't save - check the hours. Nothing was changed.",
    );
    expect(serviceSaveRefusal({ error: "invalid_input", field: "somethingNew" })).toBe(
      "Couldn't save. Nothing was changed - tap Save again.",
    );
  });
});
