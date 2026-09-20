import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { SERVICE_COLORS } from "@chairback/config/constants";
import { fallbackServiceColorKey } from "@chairback/config/serviceColor";
import type { AgendaRow } from "./page";

/**
 * WHAT A BARBER CAN SEE WITHOUT TAPPING.
 *
 * Drick compared ChairBack's calendar with Acuity's and said two things were
 * missing: the service on the card, and a colour to scan the day by. Both were
 * real:
 *
 *  1. the service line sat inside `{expanded && …}`, so a collapsed card was
 *     time + name + status and "what am I doing at 2pm" cost a tap each;
 *  2. `serviceColor` was hardcoded null for every Acuity-synced Visit, and
 *     nullable-and-unset for native services - measured on his shop, 77 of the
 *     81 cards in the next 30 days had no colour at all.
 *
 * These tests are the contract for the fix, and they exist mostly to stop a
 * future density pass quietly putting the service back behind the tap.
 */

vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("./actions", () => ({
  getAppointmentDetailAction: vi.fn(async () => ({ ok: false })),
  cancelAppointmentAction: vi.fn(),
  cancelSeriesAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  approveAppointmentAction: vi.fn(),
  declineAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
  sendNudgeAction: vi.fn(),
  grantRewardAction: vi.fn(),
}));

const { AppointmentBlock } = await import("./BookingCalendar");

const rowFor = (over: Partial<AgendaRow> = {}): AgendaRow =>
  ({
    id: "a1",
    source: "appointment",
    start: "2026-09-21T14:00:00.000Z",
    end: "2026-09-21T14:30:00.000Z",
    clientName: "Marcus Reed",
    serviceName: "Haircut",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  }) as unknown as AgendaRow;

function renderCard(over: Partial<AgendaRow> = {}) {
  const { container } = render(
    <AppointmentBlock
      row={rowFor(over)}
      timeLabel="2:00 – 2:30 PM"
      toast={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  return container;
}

/** The rendered colour of the card's left accent, as a hex. */
function stripeHex(container: HTMLElement): string | null {
  const card = container.firstElementChild as HTMLElement | null;
  const raw = card?.style.borderLeftColor ?? "";
  if (!raw) return null;
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(raw);
  if (!m) return raw.toUpperCase();
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`.toUpperCase();
}

describe("the collapsed card", () => {
  it("🔴 shows time, customer, service and status WITHOUT a tap", () => {
    // The whole of Drick's first complaint, in one assertion.
    const c = renderCard();
    expect(screen.getByText("2:00 – 2:30 PM")).toBeTruthy();
    expect(screen.getByText("Marcus Reed")).toBeTruthy();
    expect(within(c.querySelector('[data-testid="service-line"]') as HTMLElement)
      .getByText(/Haircut/)).toBeTruthy();
    expect(screen.getByText("Booked")).toBeTruthy();
  });

  it("keeps price behind the tap - that is what made the day unscrollable", () => {
    const c = renderCard({ price: 40 });
    const line = c.querySelector('[data-testid="service-line"]') as HTMLElement;
    expect(line.textContent).toContain("Haircut");
    expect(line.textContent).not.toContain("$40");
  });

  it("🔴 colour is never the only identifier - the name is always rendered", () => {
    // About one man in twelve cannot reliably separate several of these
    // swatches. A colour-only calendar is unusable for them.
    const c = renderCard({ serviceColor: "violet" });
    expect(stripeHex(c)).toBe(SERVICE_COLORS.violet.hex.toUpperCase());
    expect((c.querySelector('[data-testid="service-line"]') as HTMLElement).textContent)
      .toContain("Haircut");
  });
});

describe("which colour a card gets", () => {
  it("a native service's explicit choice wins", () => {
    expect(stripeHex(renderCard({ serviceColor: "teal" }))).toBe(
      SERVICE_COLORS.teal.hex.toUpperCase(),
    );
  });

  it("🔴 a service with NO colour still gets one, derived from its name", () => {
    // 7 of Drick's 11 native appointments in the next 30 days are this case.
    const c = renderCard({ serviceColor: null, serviceName: "Kids Haircut" });
    expect(stripeHex(c)).toBe(
      SERVICE_COLORS[fallbackServiceColorKey("Kids Haircut")].hex.toUpperCase(),
    );
  });

  it("🔴 an Acuity-synced booking is coloured like the native one", () => {
    // The synced row arrives with a name and no explicit key. Same haircut,
    // same colour - otherwise the barber learns a mapping that breaks the
    // moment a booking comes from the other system.
    const native = renderCard({ serviceColor: null, serviceName: "Haircut + Beard" });
    const nativeHex = stripeHex(native);
    const synced = renderCard({
      source: "visit",
      syncedExternal: true,
      serviceColor: null,
      serviceName: "haircut & beard",
    } as Partial<AgendaRow>);
    expect(stripeHex(synced)).toBe(nativeHex);
  });

  it("the same service is the same colour on every render", () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 5; i++) seen.add(stripeHex(renderCard({ serviceName: "VIP Package" })));
    expect(seen.size).toBe(1);
  });

  it("Drick's four services get four different colours", () => {
    const hexes = ["Haircut", "Kids Haircut", "VIP Package", "Haircut + Beard"].map((n) =>
      stripeHex(renderCard({ serviceName: n })),
    );
    expect(new Set(hexes).size).toBe(4);
  });
});

describe("what must NOT be coloured like a service", () => {
  it("a block has no service, so it gets no service colour", () => {
    // Blocks and unavailable time must stay visually distinct from work.
    const c = renderCard({
      source: "block",
      status: "blocked",
      serviceName: null,
      serviceColor: null,
      clientName: "Blocked in Acuity",
    } as Partial<AgendaRow>);
    expect(stripeHex(c)).toBeNull();
  });

  it("🔴 status stays its own signal, not a shade of the service colour", () => {
    // Completed/canceled/conflict are read from the pill. If service colour
    // encoded them, a barber could not tell a finished cut from a teal one.
    const done = renderCard({ status: "completed", serviceColor: "teal" });
    expect(screen.getByText("Completed")).toBeTruthy();
    // The accent is still the SERVICE's colour, unchanged by the status.
    expect(stripeHex(done)).toBe(SERVICE_COLORS.teal.hex.toUpperCase());
  });
});

describe("long names", () => {
  it("a long service name stays readable and fully available", () => {
    const long = "Deluxe Executive Haircut, Hot Towel Shave and Beard Sculpt";
    const c = renderCard({ serviceName: long });
    const line = c.querySelector('[data-testid="service-line"]') as HTMLElement;
    // Not truncated out of the DOM: a screen reader and a long-press both get
    // the whole thing, and the wrap class handles the visual.
    expect(line.textContent).toContain(long);
  });

  it("a long customer name is never clipped to an ambiguous prefix", () => {
    // "Ab…" is how double-books happen.
    const long = "Bartholomew Fitzgerald-Montgomery";
    renderCard({ clientName: long });
    expect(screen.getByText(long)).toBeTruthy();
  });
});
