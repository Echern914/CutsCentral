import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";

/**
 * Limits the API enforces that the Services tab didn't, and copy that
 * described a feature that no longer works that way:
 *
 *  - 🔴 a 700-minute service, or an add-on with 500 minutes of extra time,
 *    passed the form and came back as a bare "Couldn't add";
 *  - a time window's "7.5" minutes passed the check and was SENT unrounded,
 *    and a pasted "$45" price was sent as NaN (JSON null: price cleared);
 *  - the Service groups card said a group's hours replace each service's own.
 *    Groups only share an "at once" cap now; hours stay on the service.
 */

const a = vi.hoisted(() => ({
  createServiceAction: vi.fn(),
  createAddOnAction: vi.fn(),
  listTargetedSlotsAction: vi.fn(),
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

const { ServicesTab, buildTimeOverrides, dayOverridesError } = await import("./BookingManager");

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

function renderTab() {
  const toast = vi.fn();
  render(
    <ServicesTab
      initial={[RETWIST]}
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

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.createServiceAction.mockResolvedValue({ ok: true });
  a.createAddOnAction.mockResolvedValue({ ok: true });
  a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [], rules: [] });
});

describe("lengths the API would refuse", () => {
  it("🔴 a 700-minute service is refused by name, and nothing is sent", () => {
    const { toast } = renderTab();
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. .* - Classic/), { target: { value: "Locs install" } });
    fireEvent.change(screen.getAllByLabelText("Duration")[0]!, { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(toast).toHaveBeenCalledWith("Length can't be more than 600 minutes", "error");
    expect(a.createServiceAction).not.toHaveBeenCalled();
  });

  it("🔴 an add-on with 500 minutes of extra time is refused by name", () => {
    const { toast } = renderTab();
    fireEvent.change(screen.getByPlaceholderText("e.g. Beard trim"), { target: { value: "Beard" } });
    fireEvent.change(screen.getByLabelText("Extra time"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Add add-on" }));
    expect(toast).toHaveBeenCalledWith("Length can't be more than 480 minutes", "error");
    expect(a.createAddOnAction).not.toHaveBeenCalled();
  });

  it("a per-day length over the cap is named by its day", () => {
    expect(dayOverridesError({}, { 5: "700" })).toBe("Fri length: length can't be more than 600 minutes");
    expect(dayOverridesError({ 2: "abc" }, {})).toMatch(/^Tue price: /);
    expect(dayOverridesError({ 1: "45" }, { 1: "45" })).toBeNull();
  });
});

describe("time windows", () => {
  const row = (over: Record<string, unknown>) =>
    ({ start: "21:00", end: "23:00", days: [], price: "", durationMin: "", opensHours: false, ...over }) as never;

  it("🔴 sends what the check passed: minutes rounded, a pasted $ stripped", () => {
    const [w] = buildTimeOverrides([row({ price: "$45", durationMin: "7.5" })]);
    expect(w).toMatchObject({ price: 45, durationMin: 8 });
  });

  it("blank stays null (use the base price and length)", () => {
    const [w] = buildTimeOverrides([row({ opensHours: true })]);
    expect(w).toMatchObject({ price: null, durationMin: null, opensHours: true });
  });
});

describe("service groups", () => {
  it("say what a group shares now: one 'at once' cap, not hours", () => {
    renderTab();
    expect(screen.getByText(/share one 'at once' limit/)).toBeTruthy();
    expect(screen.getByText(/Hours and daily limits are still set on each service/)).toBeTruthy();
    expect(screen.queryByText(/uses the group's hours/)).toBeNull();
  });
});
