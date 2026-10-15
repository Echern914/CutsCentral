import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BlockDetail } from "./actions";
import type { AgendaRow, ServiceRow, StaffRow } from "./page";

const a = vi.hoisted(() => ({
  addBlockAction: vi.fn(),
  getBlockAction: vi.fn(),
  editBlockAction: vi.fn(),
  removeBlockAction: vi.fn(),
}));
vi.mock("./actions", () => a);

const { BlockOffForm } = await import("./BlockOffForm");
const { BlockEditSheet } = await import("./BlockEditSheet");
const { blockableServices, scopedServiceIds } = await import("./blockServices");
const { dayTotals } = await import("./dayTotals");

/**
 * Block off time for SOME services ("no Shape-ups or Kids' cuts 3-6 PM,
 * Haircuts as usual"). What has to hold in the browser:
 *  - All services stays the default, and sends no list (the whole chair);
 *  - Selected services lists only what EVERY chosen provider offers, and
 *    sends exactly the ticked ids;
 *  - picking none is stopped before anything is sent;
 *  - the review says what it stops and that the rest stays bookable;
 *  - an Acuity shop is told plainly that Acuity can't do this;
 *  - the edit sheet shows the scope and sends a change to it (null = All);
 *  - a scoped block is not counted as closed time on the calendar.
 */
const svc = (id: string, name: string, staffIds: string[], sortOrder: number, active = true): ServiceRow => ({
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
  offeredByAll: false,
  active,
  visibility: "public",
  sortOrder,
  dailyTarget: null,
  staffIds,
  serviceGroupId: null,
});
const SERVICES: ServiceRow[] = [
  svc("cut", "Haircut", ["dee", "max"], 0),
  svc("shape", "Shape-up", ["dee", "max"], 1),
  svc("kids", "Kids' cut", ["dee", "max"], 2),
  svc("design", "Beard design", ["dee"], 3),
  svc("old", "Old perm", ["dee", "max"], 4, false),
];
const STAFF: StaffRow[] = [
  { id: "dee", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
  { id: "max", name: "Max", bio: null, imageUrl: null, active: true, sortOrder: 1 },
];
const toast = vi.fn();

function openForm(props: Partial<React.ComponentProps<typeof BlockOffForm>> = {}) {
  render(
    <BlockOffForm
      staff={STAFF.slice(0, 1)}
      services={SERVICES}
      dayKey="2026-09-09"
      todayKey="2026-09-08"
      defaultFromHour={15}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={toast}
      {...props}
    />,
  );
  return screen.findByRole("dialog");
}
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const sent = () => a.addBlockAction.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.addBlockAction.mockResolvedValue({ ok: true, created: 1 });
  a.editBlockAction.mockResolvedValue({ ok: true, created: 1 });
  toast.mockReset();
});

describe("Block off time: All services or Selected services", () => {
  it("defaults to All services and sends no list", async () => {
    await openForm();
    expect(screen.getByRole("button", { name: "All services" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-qa="block-review-services"]')).toHaveTextContent("All services");
    press("Add block");
    await waitFor(() => expect(a.addBlockAction).toHaveBeenCalledTimes(1));
    expect(sent()).not.toHaveProperty("serviceIds");
  });

  it("🔴 sends exactly the ticked services, and the review says the rest stay bookable", async () => {
    await openForm();
    press("Selected services");
    const list = within(document.querySelector('[data-qa="block-services"]') as HTMLElement);
    // Active services this provider offers, in menu order. No retired ones.
    expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Haircut",
      "Shape-up",
      "Kids' cut",
      "Beard design",
    ]);
    fireEvent.click(list.getByRole("button", { name: "Shape-up" }));
    fireEvent.click(list.getByRole("button", { name: "Kids' cut" }));
    expect(document.querySelector('[data-qa="block-review-services"]')).toHaveTextContent(
      "Shape-up and Kids' cut only. Everything else stays bookable.",
    );
    press("Add block");
    await waitFor(() => expect(a.addBlockAction).toHaveBeenCalledTimes(1));
    expect(sent().serviceIds).toEqual(["shape", "kids"]);
    expect(sent().staffIds).toEqual(["dee"]);
  });

  it("stops a Selected-services save with nothing ticked", async () => {
    await openForm();
    press("Selected services");
    press("Add block");
    expect(await screen.findByText("Pick at least one service, or choose All services.")).toBeInTheDocument();
    expect(a.addBlockAction).not.toHaveBeenCalled();
  });

  it("with two providers, lists only what both offer, and drops a ticked service the second one doesn't do", async () => {
    await openForm({ staff: STAFF });
    press("Dee");
    press("Selected services");
    fireEvent.click(screen.getByRole("button", { name: "Beard design" }));
    fireEvent.click(screen.getByRole("button", { name: "Shape-up" }));
    press("Max");
    expect(screen.queryByRole("button", { name: "Beard design" })).toBeNull();
    press(/Add block/);
    await waitFor(() => expect(a.addBlockAction).toHaveBeenCalledTimes(1));
    expect(sent().serviceIds).toEqual(["shape"]);
  });

  it("tells an Acuity shop that Acuity can't block single services", async () => {
    await openForm({ acuityConnected: true });
    expect(document.querySelector('[data-qa="block-acuity-services-note"]')).toBeNull();
    press("Selected services");
    expect(document.querySelector('[data-qa="block-acuity-services-note"]')).toHaveTextContent(
      "Acuity can only block a whole calendar, not single services",
    );
  });
});

const BLOCK: BlockDetail = {
  id: "blk1",
  staffId: "dee",
  staffName: "Dee",
  startsAt: "2099-09-09T19:00:00.000Z",
  endsAt: "2099-09-09T22:00:00.000Z",
  reason: null,
  pattern: "single",
  groupId: "g1",
  serviceIds: ["kids", "shape"],
  services: [
    { id: "shape", name: "Shape-up" },
    { id: "kids", name: "Kids' cut" },
  ],
  scopeLabel: "Shape-up and Kids' cut only",
  group: { count: 1, staff: [{ id: "dee", name: "Dee" }], days: ["2099-09-09"], timesEditable: true },
};

async function openSheet(block: BlockDetail = BLOCK) {
  a.getBlockAction.mockResolvedValue({ ok: true, block, timezone: "America/New_York" });
  render(<BlockEditSheet blockId={block.id} services={SERVICES} onClose={vi.fn()} onChanged={vi.fn()} toast={toast} />);
  await waitFor(() => expect(document.querySelector('[data-qa="block-edit-scope-line"]')).not.toBeNull());
}

describe("the block's sheet", () => {
  it("says which services it stops, with them ticked", async () => {
    await openSheet();
    expect(document.querySelector('[data-qa="block-edit-scope-line"]')).toHaveTextContent(
      "Shape-up and Kids' cut only. Other services stay bookable.",
    );
    const list = within(document.querySelector('[data-qa="block-edit-services"]') as HTMLElement);
    expect(list.getByRole("button", { name: "Shape-up" })).toHaveAttribute("aria-pressed", "true");
    expect(list.getByRole("button", { name: "Haircut" })).toHaveAttribute("aria-pressed", "false");
  });

  it("🔴 sends a narrowed list, and null for All services", async () => {
    await openSheet();
    const list = within(document.querySelector('[data-qa="block-edit-services"]') as HTMLElement);
    fireEvent.click(list.getByRole("button", { name: "Shape-up" }));
    press("Save changes");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction.mock.calls[0]![1]).toMatchObject({ scope: "one", serviceIds: ["kids"] });
  });

  it("All services sends null (the whole chair)", async () => {
    await openSheet();
    fireEvent.click(
      within(document.querySelector('[data-qa="block-edit-services-scope"]') as HTMLElement).getByRole("button", {
        name: "All services",
      }),
    );
    press("Save changes");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction.mock.calls[0]![1]).toMatchObject({ serviceIds: null });
  });

  it("a block saved before scopes reads as All services and sends no list unless changed", async () => {
    const legacy: BlockDetail = { ...BLOCK, reason: "Lunch", serviceIds: undefined, services: undefined, scopeLabel: undefined };
    await openSheet(legacy);
    expect(document.querySelector('[data-qa="block-edit-scope-line"]')).toHaveTextContent("All services");
    fireEvent.change(screen.getByLabelText("Only you see this"), { target: { value: "Lunch run" } });
    press("Save changes");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction.mock.calls[0]![1]).not.toHaveProperty("serviceIds");
  });
});

describe("pure helpers", () => {
  it("blockableServices: active, offered by every chosen provider, menu order", () => {
    expect(blockableServices(SERVICES, ["dee"]).map((s) => s.id)).toEqual(["cut", "shape", "kids", "design"]);
    expect(blockableServices(SERVICES, ["dee", "max"]).map((s) => s.id)).toEqual(["cut", "shape", "kids"]);
    expect(blockableServices(SERVICES, []).map((s) => s.id)).toEqual(["cut", "shape", "kids", "design"]);
  });

  it("scopedServiceIds keeps only ticked ids still on the list", () => {
    expect(scopedServiceIds(["design", "shape"], [{ id: "shape" }])).toEqual(["shape"]);
  });

  it("dayTotals: a block of some services is not closed time", () => {
    const row = (over: Partial<AgendaRow>): AgendaRow =>
      ({
        id: "b",
        source: "block",
        start: "2099-09-09T19:00:00.000Z",
        end: "2099-09-09T20:00:00.000Z",
        clientName: "Blocked",
        serviceName: null,
        serviceColor: null,
        price: null,
        status: "blocked",
        ...over,
      }) as AgendaRow;
    expect(dayTotals([row({})]).blockedMin).toBe(60);
    expect(dayTotals([row({ blockServiceIds: ["shape"] })]).blockedMin).toBe(0);
  });
});
