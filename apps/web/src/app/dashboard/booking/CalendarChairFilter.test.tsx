import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";
import { TodayAgenda, type TodayRow } from "../_components/TodayAgenda";
import { onChair, tellableChairs } from "../_components/chairView";

/**
 * TELLING PEOPLE APART ON A SHARED CALENDAR.
 *
 * A shop with several people working it had one calendar where every booking
 * looked the same: no name on a card and no way to see one person's day. An
 * owner with four people could not answer "what does Joe have at 2" without
 * opening bookings one by one.
 *
 * What is pinned: who is on each card, that picking a person narrows the day
 * and the counts above it together, that time nobody owns never disappears,
 * and - first - that a one-person shop sees none of it.
 */

vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
}));

const { BookingCalendar } = await import("./BookingCalendar");
const { WeekView } = await import("./WeekView");

const TZ = "America/New_York";
/** Wednesday Sep 23 2026, EDT. */
const shopTime = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00-04:00`).toISOString();

const person = (id: string, name: string, over: Partial<StaffRow> = {}): StaffRow => ({
  id,
  name,
  bio: null,
  imageUrl: null,
  active: true,
  sortOrder: 0,
  ...over,
});
const SNOW = person("st_snow", "Snow");
const JOE = person("st_joe", "Joe");
const GONE = person("st_gone", "Old Hand", { active: false });

const services = [
  { id: "svc1", name: "Mens Service", durationMin: 30, price: 50, active: true },
] as unknown as ServiceRow[];

function booking(clientName: string, staffId: string, from: string, to: string, over: Partial<AgendaRow> = {}) {
  return {
    id: `${clientName}-${from}`,
    source: "appointment",
    start: shopTime(from),
    end: shopTime(to),
    clientName,
    serviceName: "Mens Service",
    serviceId: "svc1",
    staffId,
    serviceColor: null,
    price: 50,
    status: "upcoming",
    ...over,
  } as AgendaRow;
}

function block(reason: string, staffId: string | null, from: string, to: string): AgendaRow {
  return {
    id: `block-${reason}`,
    source: "block",
    start: shopTime(from),
    end: shopTime(to),
    clientName: reason,
    staffId,
    serviceName: null,
    serviceColor: null,
    price: null,
    status: "blocked",
  } as AgendaRow;
}

const DAY = [
  booking("Andre Bell", SNOW.id, "10:00", "10:30"),
  booking("Will Park", JOE.id, "10:00", "10:30"),
  booking("Marcus Lee", JOE.id, "13:00", "13:30"),
  block("Joe at the bank", JOE.id, "15:00", "16:00"),
  block("Fire drill", null, "16:00", "16:30"),
  // A booking synced from somewhere that never said who it is with.
  { ...booking("Booked Elsewhere", "", "18:00", "18:30"), source: "visit", staffId: null } as AgendaRow,
];

function renderDay(agenda: AgendaRow[], staff: StaffRow[]) {
  const initial: AgendaResponse = { agenda, source: "appointment", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative
      staff={staff}
      services={services}
      toast={() => {}}
      openView="day"
    />,
  );
}

const strip = () => document.querySelector<HTMLElement>('[data-qa="chair-filter"]');
const chipNames = () => screen.queryAllByTestId("chair-chip").map((el) => el.textContent);
const shownClients = () =>
  screen
    .queryAllByRole("button", { name: /^(Expand|Collapse) appointment for / })
    .map((b) => b.getAttribute("aria-label")!.replace(/^(Expand|Collapse) appointment for /, ""));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(shopTime("09:00")));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a one-person shop is unchanged", () => {
  it("🔴 no filter row and no name on any card", () => {
    renderDay([booking("Andre Bell", SNOW.id, "10:00", "10:30")], [SNOW]);
    expect(shownClients()).toEqual(["Andre Bell"]);
    expect(strip()).toBeNull();
    expect(chipNames()).toEqual([]);
  });

  it("🔴 somebody who no longer works here does not make it a team", () => {
    renderDay([booking("Andre Bell", SNOW.id, "10:00", "10:30")], [SNOW, GONE]);
    expect(strip()).toBeNull();
    expect(chipNames()).toEqual([]);
  });

  it("the rule itself: two ACTIVE people, never fewer", () => {
    expect(tellableChairs([SNOW])).toEqual([]);
    expect(tellableChairs([SNOW, GONE])).toEqual([]);
    expect(tellableChairs([SNOW, JOE, GONE]).map((s) => s.name)).toEqual(["Snow", "Joe"]);
  });
});

describe("a shop several people work", () => {
  it("every booking says who it is with", () => {
    renderDay(DAY, [SNOW, JOE]);
    expect(shownClients()).toEqual(["Andre Bell", "Will Park", "Marcus Lee", "Booked Elsewhere"]);
    // One chip per booking that names somebody; the synced one names nobody.
    expect(chipNames()).toEqual(["Snow", "Joe", "Joe"]);
  });

  it("offers Everyone and each active person, and nobody who left", () => {
    renderDay(DAY, [SNOW, JOE, GONE]);
    const chips = within(strip()!).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Everyone", "Snow", "Joe"]);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("🔴 picking a person shows that person's day, and the count above it agrees", () => {
    renderDay(DAY, [SNOW, JOE]);
    expect(screen.getByText("4 appointments")).toBeTruthy();

    fireEvent.click(within(strip()!).getByRole("button", { name: "Joe" }));
    // Joe's two, plus the booking nobody is named on.
    expect(shownClients()).toEqual(["Will Park", "Marcus Lee", "Booked Elsewhere"]);
    expect(screen.queryByText("4 appointments")).toBeNull();
    expect(screen.getByText("3 appointments")).toBeTruthy();
    // Every card is Joe's now, so the cards stop repeating his name.
    expect(chipNames()).toEqual([]);
    expect(within(strip()!).getByRole("button", { name: "Joe" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("🔴 blocked time: theirs and the whole shop's stay, another person's goes", () => {
    renderDay(DAY, [SNOW, JOE]);
    expect(screen.getByText("Joe at the bank")).toBeTruthy();
    expect(screen.getByText("Fire drill")).toBeTruthy();

    fireEvent.click(within(strip()!).getByRole("button", { name: "Snow" }));
    expect(shownClients()).toEqual(["Andre Bell", "Booked Elsewhere"]);
    expect(screen.queryByText("Joe at the bank")).toBeNull();
    expect(screen.getByText("Fire drill")).toBeTruthy();
  });

  it("tapping the lit name, or Everyone, goes back to the whole shop", () => {
    renderDay(DAY, [SNOW, JOE]);
    fireEvent.click(within(strip()!).getByRole("button", { name: "Joe" }));
    fireEvent.click(within(strip()!).getByRole("button", { name: "Joe" }));
    expect(shownClients()).toHaveLength(4);

    fireEvent.click(within(strip()!).getByRole("button", { name: "Snow" }));
    fireEvent.click(within(strip()!).getByRole("button", { name: "Everyone" }));
    expect(shownClients()).toHaveLength(4);
    expect(chipNames()).toEqual(["Snow", "Joe", "Joe"]);
  });

  it("🔴 the pick survives paging to another day and back", () => {
    renderDay(DAY, [SNOW, JOE]);
    fireEvent.click(within(strip()!).getByRole("button", { name: "Joe" }));
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(within(strip()!).getByRole("button", { name: "Joe" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(shownClients()).toEqual(["Will Park", "Marcus Lee", "Booked Elsewhere"]);
  });

  it("a new booking made from one person's calendar starts on that person", () => {
    renderDay(DAY, [SNOW, JOE]);
    fireEvent.click(within(strip()!).getByRole("button", { name: "Joe" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New appointment" }));
    const dialog = screen.getByRole("dialog");
    const picked = within(dialog)
      .getAllByRole("button", { pressed: true })
      .map((b) => b.textContent);
    expect(picked).toContain("Joe");
    expect(picked).not.toContain("Snow");
  });

  it("the row rule: a row naming nobody belongs on everybody's day", () => {
    expect(onChair({ staffId: "st_joe" }, "st_joe")).toBe(true);
    expect(onChair({ staffId: "st_snow" }, "st_joe")).toBe(false);
    expect(onChair({ staffId: null }, "st_joe")).toBe(true);
    expect(onChair({}, "st_joe")).toBe(true);
  });
});

describe("the week grid", () => {
  const minuteOf = (iso: string) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const num = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return num("hour") * 60 + num("minute");
  };
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const days = Array.from({ length: 7 }, (_, i) => ({ key: `2026-09-${20 + i}`, count: i === 3 ? 2 : 0 }));
  const rows = new Map([
    [
      "2026-09-23",
      [booking("Andre Bell", SNOW.id, "10:00", "11:00"), booking("Will Park", JOE.id, "12:00", "13:00")],
    ],
  ]);
  const week = (chairs: StaffRow[]) =>
    render(
      <WeekView
        days={days}
        rowsByDay={rows}
        todayKey="2026-09-23"
        timeZone={TZ}
        timeFmt={timeFmt}
        minuteOf={minuteOf}
        staff={[SNOW, JOE]}
        chairs={chairs}
        isNative
        onOpen={() => {}}
        onOpenBlock={() => {}}
        onOpenDay={() => {}}
      />,
    );
  const events = () =>
    [...document.querySelectorAll('[data-qa="week-event"]')].map((el) => el.getAttribute("aria-label"));

  it("names who each booking is with, ahead of the service", () => {
    week([SNOW, JOE]);
    expect(events()).toEqual([
      "Andre Bell, 10:00 AM, Snow, Mens Service, Booked",
      "Will Park, 12:00 PM, Joe, Mens Service, Booked",
    ]);
    expect(screen.getByText("10:00 AM · Snow · Mens Service")).toBeTruthy();
  });

  it("🔴 with nobody to tell apart, a booking reads exactly as it did", () => {
    week([]);
    expect(events()).toEqual([
      "Andre Bell, 10:00 AM, Mens Service, Booked",
      "Will Park, 12:00 PM, Mens Service, Booked",
    ]);
    expect(screen.getByText("10:00 AM · Mens Service")).toBeTruthy();
  });
});

describe("Today on the dashboard", () => {
  const at = (hhmm: string) => `2026-11-16T${hhmm}:00.000Z`;
  const NOW = Date.parse(at("15:42"));
  const todayRows: TodayRow[] = [
    {
      id: "a",
      source: "appointment",
      start: at("16:00"),
      end: at("16:30"),
      staffId: SNOW.id,
      clientName: "Andre Bell",
      serviceName: "Cut",
      serviceColor: null,
      price: 40,
      status: "upcoming",
    },
    {
      id: "b",
      source: "appointment",
      start: at("17:00"),
      end: at("17:30"),
      staffId: JOE.id,
      clientName: "Will Park",
      serviceName: "Cut",
      serviceColor: null,
      price: 40,
      status: "upcoming",
    },
    {
      id: "c",
      source: "block",
      start: at("18:00"),
      end: at("18:30"),
      staffId: JOE.id,
      clientName: "Lunch",
      serviceName: null,
      serviceColor: null,
      price: null,
      status: "blocked",
    },
  ];

  it("says who each booking is with once two people work here", () => {
    render(<TodayAgenda rows={todayRows} timezone={TZ} now={NOW} staff={[SNOW, JOE]} />);
    // The two bookings; a block is nobody's appointment.
    expect(chipNames()).toEqual(["Snow", "Joe"]);
    // "Up next" names them too.
    expect(screen.getByText(/Cut · Snow · /)).toBeTruthy();
  });

  it("🔴 a one-person shop, or a page with no list of people, shows no names", () => {
    const { unmount } = render(<TodayAgenda rows={todayRows} timezone={TZ} now={NOW} staff={[SNOW]} />);
    expect(chipNames()).toEqual([]);
    unmount();
    render(<TodayAgenda rows={todayRows} timezone={TZ} now={NOW} />);
    expect(chipNames()).toEqual([]);
    expect(screen.queryByText(/Cut · Snow · /)).toBeNull();
  });
});
