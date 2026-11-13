import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AddOnRow, ServiceRow, StaffRow } from "./page";

/**
 * A service's own page.
 *
 * Editing a service was one tall form with every editor open at once, and the
 * things you could DO to a service (hide it, copy it, remove it) were 16px
 * links on its row in the menu. Now:
 *
 *   - the page is rows, each saying what the setting is set to, and a row's
 *     editor opens under it when tapped;
 *   - what is typed in a row survives closing it, and shows on the row before
 *     Save;
 *   - a refused value opens the row it is in;
 *   - show/hide, duplicate and remove are rows at the foot of the page. They
 *     act on the service as SAVED, right away, and say what happened on the
 *     page - a toast raised from inside a sheet is behind it on a phone.
 */

const a = vi.hoisted(() => ({
  updateServiceAction: vi.fn(),
  createServiceAction: vi.fn(),
  deleteServiceAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listTargetedSlotsAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServiceEditForm } = await import("./BookingManager");

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

function open(
  row = service(),
  extra: { services?: ServiceRow[]; addOns?: AddOnRow[]; groupName?: string | null } = {},
) {
  const toast = vi.fn();
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ServiceEditForm
      service={row}
      services={extra.services ?? [row]}
      staff={staff}
      addOns={extra.addOns}
      groupName={extra.groupName ?? null}
      timezone="UTC"
      toast={toast}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { toast, onClose, onSaved };
}

const page = () => within(screen.getByRole("dialog", { name: "Edit service" }));
/** A row, by the label it starts with. */
const row = (label: string) => page().getByRole("button", { name: new RegExp(`^${label}`) });
const save = () => fireEvent.click(page().getByRole("button", { name: "Save changes" }));

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const fn of Object.values(a)) fn.mockReset();
  a.updateServiceAction.mockResolvedValue({ ok: true });
  a.createServiceAction.mockResolvedValue({ ok: true });
  a.deleteServiceAction.mockResolvedValue({ ok: true });
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  confirmSpy.mockRestore();
});

describe("a service's page is rows that say what is set", () => {
  it("🔴 opens as a list: name, length and price on show, every editor closed", () => {
    open();
    expect(page().getByRole("textbox", { name: "Service name" })).toHaveValue("Retwist");
    const rows = page()
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-expanded"));
    expect(rows.map((b) => b.getAttribute("aria-expanded"))).toEqual(rows.map(() => "false"));
    expect(rows.map((b) => b.firstElementChild?.textContent)).toEqual([
      "Description and photo",
      "Who does it",
      "Calendar color",
      "Weekly hours",
      "Most per day",
      "By day of the week",
      "By time of day",
      "On one date",
    ]);
  });

  it("is headed by the service's name, and still announced as the edit sheet", () => {
    open(service({ visibility: "hidden" }), { groupName: "Locs" });
    const heading = page().getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Retwist");
    expect(heading).toHaveTextContent("Locs · Hidden from clients");
  });

  it("a plain service reads as plain", () => {
    open();
    expect(row("Description and photo")).toHaveTextContent("None");
    expect(row("Who does it")).toHaveTextContent("Everyone");
    expect(row("Calendar color")).toHaveTextContent("None");
    expect(row("Weekly hours")).toHaveTextContent("Regular hours");
    expect(row("Most per day")).toHaveTextContent("No limit");
    expect(row("By day of the week")).toHaveTextContent("Same every day");
    expect(row("By time of day")).toHaveTextContent("None");
    expect(row("On one date")).toHaveTextContent("None");
  });

  it("🔴 each row says what the service is set to, without opening it", () => {
    open(
      service({
        description: "Wash and retwist",
        color: "green",
        priceOverrides: { "0": 55 },
        dailyLimits: { "6": 8 },
        hoursWindows: { "1": [{ s: 600, e: 840 }] },
        timeOverrides: [{ s: 1260, e: 1380, price: 60, durationMin: null }],
        dateOverrides: { "2099-12-24": 80 },
      }),
    );
    expect(row("Description and photo")).toHaveTextContent("Description");
    expect(row("Calendar color")).toHaveTextContent("Green");
    expect(row("Weekly hours")).toHaveTextContent("Custom on 1 day");
    expect(row("Most per day")).toHaveTextContent("Sat 8");
    expect(row("By day of the week")).toHaveTextContent("Sun $55");
    expect(row("By time of day")).toHaveTextContent("9 PM-11 PM $60");
    expect(row("On one date")).toHaveTextContent("Dec 24 $80");
  });

  it("tapping a row opens its editor; opening another closes it", () => {
    open();
    expect(page().queryByRole("spinbutton", { name: "Sun price" })).toBeNull();
    fireEvent.click(row("By day of the week"));
    expect(row("By day of the week")).toHaveAttribute("aria-expanded", "true");
    expect(page().getByRole("spinbutton", { name: "Sun price" })).toBeTruthy();

    fireEvent.click(row("Most per day"));
    expect(row("By day of the week")).toHaveAttribute("aria-expanded", "false");
    expect(page().queryByRole("spinbutton", { name: "Sun price" })).toBeNull();
    expect(page().getByRole("spinbutton", { name: "Most Sun bookings of this service in a day" })).toBeTruthy();

    // And a second tap closes the open one.
    fireEvent.click(row("Most per day"));
    expect(row("Most per day")).toHaveAttribute("aria-expanded", "false");
  });

  it("🔴 the row follows what is typed, and a closed row keeps it", () => {
    open();
    fireEvent.click(row("By day of the week"));
    fireEvent.change(page().getByRole("spinbutton", { name: "Sun price" }), { target: { value: "55" } });
    expect(row("By day of the week")).toHaveTextContent("Sun $55");

    fireEvent.click(row("Most per day"));
    fireEvent.click(row("By day of the week"));
    expect(page().getByRole("spinbutton", { name: "Sun price" })).toHaveValue(55);
  });

  it("one Save writes what every row holds, open or closed", async () => {
    const { onSaved } = open();
    fireEvent.click(row("By day of the week"));
    fireEvent.change(page().getByRole("spinbutton", { name: "Sun price" }), { target: { value: "55" } });
    fireEvent.click(row("Most per day"));
    fireEvent.change(page().getByRole("spinbutton", { name: "Most Sat bookings of this service in a day" }), {
      target: { value: "8" },
    });
    fireEvent.click(row("Most per day"));
    save();
    await waitFor(() => expect(a.updateServiceAction).toHaveBeenCalledTimes(1));
    expect(a.updateServiceAction.mock.calls[0]![1]).toMatchObject({
      priceOverrides: { "0": 55 },
      dailyLimits: { "6": 8 },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("🔴 a value the page refuses opens the row it is in", async () => {
    open();
    // Pick people by hand, then leave nobody picked.
    fireEvent.click(row("Who does it"));
    fireEvent.click(page().getByRole("button", { name: "Dee" }));
    expect(row("Who does it")).toHaveTextContent("Nobody picked");
    fireEvent.click(row("Who does it"));
    expect(row("Who does it")).toHaveAttribute("aria-expanded", "false");

    save();
    expect(await page().findByRole("alert")).toHaveTextContent("Pick at least one");
    expect(row("Who does it")).toHaveAttribute("aria-expanded", "true");
    expect(a.updateServiceAction).not.toHaveBeenCalled();
  });

  it("🔴 a value the SERVER refuses opens its row too", async () => {
    a.updateServiceAction.mockResolvedValue({ ok: false, error: "bad_request", field: "dailyLimits" });
    open();
    save();
    expect(await page().findByRole("alert")).toHaveTextContent("check the daily limits");
    expect(row("Most per day")).toHaveAttribute("aria-expanded", "true");
  });

  it("hours copied from another service are said in the row, not in a toast", () => {
    const donor = service({ id: "svc2", name: "Loc detox", hoursWindows: { "1": [{ s: 600, e: 840 }] } });
    const mine = service();
    const { toast } = open(mine, { services: [mine, donor] });
    fireEvent.click(row("Weekly hours"));
    fireEvent.change(page().getByRole("combobox", { name: "Copy hours from another service" }), {
      target: { value: "svc2" },
    });
    expect(page().getByRole("status")).toHaveTextContent("Hours copied from Loc detox. Save to keep them.");
    expect(row("Weekly hours")).toHaveTextContent("Custom on 1 day");
    expect(toast).not.toHaveBeenCalled();
  });

  it("says which add-ons go with it, and where they are set up", () => {
    open(service(), {
      addOns: [
        { id: "a1", name: "Beard trim", durationMin: 10, price: 10, serviceIds: [], active: true, sortOrder: 0 },
        { id: "a2", name: "Design", durationMin: 10, price: 15, serviceIds: ["svc1"], active: true, sortOrder: 1 },
        { id: "a3", name: "Wash", durationMin: 10, price: 15, serviceIds: ["other"], active: true, sortOrder: 2 },
      ],
    });
    expect(page().getByText("Beard trim, Design")).toBeTruthy();
    expect(page().getByText("Add-ons are set up under Services → Extras.")).toBeTruthy();
  });
});

describe("show or hide, on the page, right away", () => {
  const shown = () => page().getByRole("switch", { name: "Shown to clients" });

  it("🔴 hiding is said on the page (never a toast) and the menu hears about it", async () => {
    const { toast, onSaved } = open();
    expect(shown()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(shown());
    await waitFor(() => expect(shown()).toHaveAttribute("aria-checked", "false"));
    expect(a.updateServiceAction).toHaveBeenCalledWith("svc1", { visibility: "hidden" });
    expect(page().getByRole("status")).toHaveTextContent("Hidden from clients. You can still book it yourself.");
    expect(page().getByRole("heading", { level: 2 })).toHaveTextContent("Hidden from clients");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "svc1", visibility: "hidden" }));
    expect(toast).not.toHaveBeenCalled();
  });

  it("showing a hidden service puts it back", async () => {
    open(service({ visibility: "hidden" }));
    expect(shown()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(shown());
    await waitFor(() => expect(shown()).toHaveAttribute("aria-checked", "true"));
    expect(a.updateServiceAction).toHaveBeenCalledWith("svc1", { visibility: "public" });
    expect(page().getByRole("status")).toHaveTextContent("Back on your booking page.");
  });

  it("a refusal changes nothing and says so", async () => {
    a.updateServiceAction.mockResolvedValue({ ok: false, error: "bad_request" });
    const { onSaved } = open();
    fireEvent.click(shown());
    expect(await page().findByRole("alert")).toHaveTextContent("Couldn't change that. Nothing was changed");
    expect(shown()).toHaveAttribute("aria-checked", "true");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a lost connection is a refusal, not a crash", async () => {
    a.updateServiceAction.mockRejectedValue(new Error("offline"));
    open();
    fireEvent.click(shown());
    expect(await page().findByRole("alert")).toHaveTextContent("Couldn't change that");
  });

  it("🔴 hiding sends ONLY that - a half-typed name is neither saved nor shown on the menu", async () => {
    const { onSaved } = open();
    fireEvent.change(page().getByRole("textbox", { name: "Service name" }), { target: { value: "Retwist + style" } });
    fireEvent.click(shown());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(a.updateServiceAction).toHaveBeenCalledWith("svc1", { visibility: "hidden" });
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ name: "Retwist", visibility: "hidden" });
    // The draft is still on the page.
    expect(page().getByRole("textbox", { name: "Service name" })).toHaveValue("Retwist + style");
  });

  it("🔴 a Save after hiding hands the menu a row that is still hidden", async () => {
    const { onSaved } = open();
    fireEvent.click(shown());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(onSaved.mock.calls[1]![0]).toMatchObject({ visibility: "hidden" });
  });
});

describe("duplicate, on the page", () => {
  const duplicate = () => page().getByRole("button", { name: "Duplicate Retwist" });

  it("copies the service and says so on the page, which stays open", async () => {
    const { toast, onClose } = open();
    fireEvent.click(duplicate());
    expect(await page().findByRole("status")).toHaveTextContent('Copied. "Retwist copy" is on your menu');
    expect(a.createServiceAction).toHaveBeenCalledWith(expect.objectContaining({ name: "Retwist copy" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("🔴 the copy is made from what is SAVED, not from what is half-typed", async () => {
    open();
    fireEvent.change(page().getByRole("textbox", { name: "Service name" }), { target: { value: "Something else" } });
    fireEvent.click(duplicate());
    await waitFor(() => expect(a.createServiceAction).toHaveBeenCalledTimes(1));
    expect(a.createServiceAction.mock.calls[0]![0]).toMatchObject({ name: "Retwist copy" });
  });

  it("a refusal says nothing was added", async () => {
    a.createServiceAction.mockResolvedValue({ ok: false, error: "bad_request" });
    open();
    fireEvent.click(duplicate());
    expect(await page().findByRole("alert")).toHaveTextContent("Couldn't duplicate. Nothing was added");
  });

  it("🔴 two taps make one copy", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    a.createServiceAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open();
    fireEvent.click(duplicate());
    fireEvent.click(duplicate());
    finish({ ok: true });
    await page().findByRole("status");
    expect(a.createServiceAction).toHaveBeenCalledTimes(1);
  });
});

describe("remove, on the page", () => {
  const remove = () => page().getByRole("button", { name: "Remove Retwist" });

  it("🔴 asks first, saying what is lost - and a No removes nothing", () => {
    confirmSpy.mockReturnValue(false);
    const { onClose } = open();
    fireEvent.click(remove());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toMatch(/Remove "Retwist"\? Its prices, hours and staff setup are deleted\. This can't be undone\./);
    expect(a.deleteServiceAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("names the group it leaves", () => {
    confirmSpy.mockReturnValue(false);
    open(service(), { groupName: "Locs" });
    fireEvent.click(remove());
    expect(confirmSpy.mock.calls[0]![0]).toContain('and it leaves the "Locs" group');
  });

  it("a Yes removes it, closes the page, and says so where it can be seen", async () => {
    const { toast, onClose } = open();
    fireEvent.click(remove());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(a.deleteServiceAction).toHaveBeenCalledWith("svc1");
    // The page is closed by now, so the toast is not behind anything.
    expect(toast).toHaveBeenCalledWith("Service removed", "success");
  });

  it("a refusal keeps the page open and says nothing was changed", async () => {
    a.deleteServiceAction.mockResolvedValue({ ok: false, error: "bad_request" });
    const { toast, onClose } = open();
    fireEvent.click(remove());
    expect(await page().findByRole("alert")).toHaveTextContent("Couldn't remove it. Nothing was changed");
    expect(onClose).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a row that opens stays where the thumb is", () => {
  // jsdom has no scrollIntoView. Stand one in that remembers who was scrolled.
  let scrolled: { el: Element; arg: unknown }[] = [];
  const proto = Element.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
  beforeEach(() => {
    scrolled = [];
    proto.scrollIntoView = function (this: Element, arg?: unknown) {
      scrolled.push({ el: this, arg });
    };
  });
  afterEach(() => {
    delete proto.scrollIntoView;
  });

  it("🔴 opening a row brings THAT row back on screen, no further than needed", () => {
    // Opening one row closes the one above it, and the page moves up by that
    // editor's whole height. On a phone the row just tapped went off the top.
    open();
    expect(scrolled).toHaveLength(0); // nothing moves when the page opens
    fireEvent.click(row("By day of the week"));
    fireEvent.click(row("Most per day"));
    expect(scrolled.map((s) => s.el)).toEqual([row("By day of the week"), row("Most per day")]);
    expect(scrolled[1]!.arg).toEqual({ block: "nearest" });
  });

  it("closing a row moves nothing", () => {
    open();
    fireEvent.click(row("Most per day"));
    fireEvent.click(row("Most per day"));
    expect(scrolled).toHaveLength(1);
  });
});

describe("an editor does not repeat its row", () => {
  it("the old question headings are gone from the page; the row is the heading", () => {
    open();
    for (const old of ["Vary by day?", "Vary by time of day?", "Limit how many a day?", "special dates (optional)"]) {
      expect(page().queryByText(old, { exact: false })).toBeNull();
    }
    // What each editor explains is still there.
    fireEvent.click(row("Most per day"));
    expect(page().getByText("A hard cap, per day of the week.", { exact: false })).toBeTruthy();
  });

  it("who does it says what the choice means", () => {
    open();
    fireEvent.click(row("Who does it"));
    expect(page().getByText("All providers, including any added later.")).toBeTruthy();
    fireEvent.click(page().getByRole("button", { name: "Dee" }));
    expect(page().getByText("Only the providers picked here.")).toBeTruthy();
  });
});
