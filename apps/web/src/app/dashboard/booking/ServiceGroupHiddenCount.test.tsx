import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceGroupRow, ServiceRow, StaffRow } from "./page";

/**
 * A group's count on the dashboard vs on the booking page.
 *
 * A barber's "Clients Only" group said 6 services here and 5 on the booking
 * page. The dashboard counts every member; the booking page never lists a
 * service the barber has hidden (the eye icon). Both are right - so the group
 * row now says why: "6 services (1 hidden)".
 */

vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  getAvailabilityAction: vi.fn(async () => ({ ok: true, data: { rules: [] } })),
  listSpecialDaysAction: vi.fn(async () => ({ ok: true, specialDays: [] })),
  listTargetedSlotsAction: vi.fn(async () => ({ ok: false })),
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
  return {
    id,
    name,
    maxPerDay: null,
    maxConcurrent: null,
    dailyTarget: null,
    active: true,
    sortOrder,
    serviceIds,
  };
}

function renderTab() {
  const services = [
    service("a", "Regular Cut", { serviceGroupId: "g1" }),
    service("b", "Private Cut", { serviceGroupId: "g1", visibility: "hidden" }),
    service("c", "Regular Beard", { serviceGroupId: "g1" }),
    service("d", "First Cut", { serviceGroupId: "g2" }),
    service("e", "First Beard", { serviceGroupId: "g2" }),
  ];
  render(
    <ServicesTab
      initial={services}
      staff={staff}
      initialServiceGroups={[
        group("g1", "Clients Only", ["a", "b", "c"], 0),
        group("g2", "First Time Clients", ["d", "e"], 1),
      ]}
      initialAddOns={[]}
      timezone="America/New_York"
      toast={vi.fn()}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
    />,
  );
}

describe("a group's member count says how many are hidden", () => {
  it("🔴 '3 services (1 hidden)' when a member is hidden from clients", () => {
    renderTab();
    const row = screen.getByRole("button", { name: /^Clients Only/ });
    expect(row.textContent).toMatch(/3 services \(1 hidden\)/);
  });

  it("a group with nothing hidden reads as before", () => {
    renderTab();
    const row = screen.getByRole("button", { name: /^First Time Clients/ });
    expect(row.textContent).toMatch(/2 services ·/);
    expect(row.textContent).not.toMatch(/hidden/);
  });
});
