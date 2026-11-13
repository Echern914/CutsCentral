import { datesLabel, spansLabel } from "@chairback/config/dateHoursPlan";
import { changeSignature } from "./dayChanges";
import { zonedDateKey } from "@chairback/config/time";
import { collapseRuns, expandRange } from "@/lib/dateRanges";
import type { SpecialDayRow, TargetedSlotRow } from "./actions";
import type { ServiceRow, StaffRow } from "./page";

/**
 * EVERY SPECIAL DATE, AS ONE LIST.
 *
 * A date can run differently from the usual week in four ways, and each one
 * was set up on its own card with its own list: a holiday price, a special
 * day, one service's own hours on a date, and a one-time opening. To answer
 * "what is different about Thanksgiving week" a barber read four lists.
 *
 * This reads the same four stores and gives back ONE list, soonest first,
 * grouped by month. Nothing new is stored and nothing here writes: each row
 * says what it is and where a tap goes, and the tools that already own the
 * change do the changing.
 *
 * Pure on purpose - no React, no fetch - so the words on each row are tested
 * without drawing anything.
 */

export type SpecialDateKind = "price" | "day" | "hours" | "closed" | "opening";

/** Where a tap on a row goes. */
export type SpecialDateTarget =
  | { kind: "price"; dates: string[] }
  | { kind: "day"; date: string; name?: string }
  | { kind: "hours"; serviceId: string }
  | { kind: "opening"; slotId: string };

export interface SpecialDateEntry {
  key: string;
  kind: SpecialDateKind;
  /** The first of its dates still ahead: the tile, and where the row sorts. */
  date: string;
  /** Every one of its dates still ahead, soonest first. */
  dates: string[];
  title: string;
  sub: string;
  target: SpecialDateTarget;
}

export interface SpecialDateMonth {
  /** "2026-11" */
  key: string;
  /** "November", or "January 2027" once the year is not this one. */
  label: string;
  entries: SpecialDateEntry[];
}

/** What the chip on a row says. Short: it sits beside the title on a phone. */
export const KIND_LABEL: Record<SpecialDateKind, string> = {
  price: "Price",
  day: "Special day",
  hours: "Hours",
  closed: "Closed",
  opening: "Open",
};

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rows on one date read in this order: the biggest change first. */
const KIND_ORDER: SpecialDateKind[] = ["closed", "day", "hours", "price", "opening"];

function money(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The first two, then how many more: a row has room for a few words. */
function few(items: string[], max = 2): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

/** "Nov 26", or "Dec 25 - 31", or "Dec 30 - Jan 2". */
export function rangeLabel(from: string, to: string): string {
  const [, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [, tm, td] = to.split("-").map(Number) as [number, number, number];
  const first = `${MONTH_SHORT[fm - 1]} ${fd}`;
  if (from === to) return first;
  return fm === tm ? `${first} – ${td}` : `${first} – ${MONTH_SHORT[tm - 1]} ${td}`;
}

//  Holiday prices

/** A date with everything priced on it, assembled back out of the services. */
export interface HolidayGroup {
  date: string;
  entries: { serviceId: string; serviceName: string; price: number }[];
}

/** A stretch of days priced identically under one name. */
export interface HolidayRun {
  from: string;
  to: string;
  dates: string[];
  group: HolidayGroup;
}

/**
 * Every priced date across every service, soonest first. Built from the same
 * `dateOverrides` the service's own page writes, so the two cannot disagree.
 */
export function holidayGroups(
  services: Pick<ServiceRow, "id" | "name" | "dateOverrides">[],
): HolidayGroup[] {
  const byDate = new Map<string, HolidayGroup["entries"]>();
  for (const s of services) {
    for (const [d, p] of Object.entries(s.dateOverrides ?? {})) {
      byDate.set(d, [...(byDate.get(d) ?? []), { serviceId: s.id, serviceName: s.name, price: Number(p) }]);
    }
  }
  return [...byDate.entries()]
    .map(([date, entries]) => ({ date, entries }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Contiguous days priced IDENTICALLY (the same services at the same prices,
 * under the same name) are one run: "Dec 25 - 31". Days that differ stay
 * separate - joining them would hide a real difference.
 */
export function holidayRuns(groups: HolidayGroup[], names: Record<string, string>): HolidayRun[] {
  // The NAME is part of the signature: Dec 24 "Christmas Eve" and Dec 25
  // "Christmas" priced alike are still two holidays.
  const signature = (g: HolidayGroup) =>
    JSON.stringify([
      names[g.date] ?? "",
      [...g.entries].map((e) => [e.serviceId, e.price] as const).sort((a, b) => a[0].localeCompare(b[0])),
    ]);
  const byDate = new Map(groups.map((g) => [g.date, g]));
  const out: HolidayRun[] = [];
  for (const run of collapseRuns(groups.map((g) => g.date))) {
    let days = expandRange(run.from, run.to) ?? [run.from];
    // Split a contiguous stretch wherever the pricing changes mid-run.
    while (days.length > 0) {
      const first = byDate.get(days[0]!)!;
      const sig = signature(first);
      let n = 1;
      while (n < days.length && signature(byDate.get(days[n]!)!) === sig) n++;
      out.push({ from: days[0]!, to: days[n - 1]!, dates: days.slice(0, n), group: first });
      days = days.slice(n);
    }
  }
  return out;
}

/** "Every service $65", "3 services $65", or "Haircut $60, Beard trim $25 +1". */
export function priceWords(entries: HolidayGroup["entries"], activeServiceIds: readonly string[]): string {
  const prices = [...new Set(entries.map((e) => e.price))];
  if (prices.length === 1 && entries.length > 1) {
    const priced = new Set(entries.map((e) => e.serviceId));
    const everyActive = activeServiceIds.length > 0 && activeServiceIds.every((id) => priced.has(id));
    return `${everyActive ? "Every service" : plural(entries.length, "service")} ${money(prices[0]!)}`;
  }
  return few(entries.map((e) => `${e.serviceName} ${money(e.price)}`));
}

//  The list

export function buildSpecialDates(input: {
  services: ServiceRow[];
  staff: Pick<StaffRow, "id" | "name">[];
  /** The shop's names for its dates ({"2026-11-26": "Thanksgiving"}). */
  names: Record<string, string>;
  /** Upcoming special days, one row per staff member. */
  specialDays: SpecialDayRow[];
  /** Every published slot; only the one-time ones are dates. */
  slots: TargetedSlotRow[];
  /** The weekly series still running. A slot whose series is gone stands alone. */
  rules: { id: string }[];
  /** The SHOP's date today. */
  today: string;
  timezone: string;
}): SpecialDateEntry[] {
  const { services, staff, names, specialDays, slots, rules, today, timezone } = input;
  const staffName = (id: string) => staff.find((s) => s.id === id)?.name ?? null;
  const serviceName = (id: string) => services.find((s) => s.id === id)?.name ?? "Service";
  const out: SpecialDateEntry[] = [];

  // A different price on a date.
  const activeIds = services.filter((s) => s.active).map((s) => s.id);
  for (const run of holidayRuns(holidayGroups(services), names)) {
    const ahead = run.dates.filter((d) => d >= today);
    if (ahead.length === 0) continue;
    const name = names[run.from]?.trim();
    const prices = priceWords(run.group.entries, activeIds);
    const span = ahead.length > 1 ? rangeLabel(ahead[0]!, ahead[ahead.length - 1]!) : null;
    out.push({
      key: `price:${run.from}`,
      kind: "price",
      date: ahead[0]!,
      dates: ahead,
      title: name || prices,
      sub: name ? [span, prices].filter(Boolean).join(" · ") : (span ?? "A different price that day"),
      // The whole run, passed days included: that is the stretch as it is saved.
      target: { kind: "price", dates: run.dates },
    });
  }

  // A date run its own way. Every staff member's day on one date goes together.
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  const days = new Map<string, SpecialDayRow[]>();
  for (const r of specialDays) {
    if (r.date < today) continue;
    const k = `${r.date}|${r.name ?? ""}`;
    days.set(k, [...(days.get(k) ?? []), r]);
  }
  for (const group of days.values()) {
    const first = group[0]!;
    const openings = group.reduce((n, r) => n + r.openings, 0);
    const booked = group.reduce((n, r) => n + r.booked, 0);
    const low = Math.min(...group.map((r) => r.minPrice ?? r.price));
    const high = Math.max(...group.map((r) => r.maxPrice ?? r.price));
    const starts = group.map((r) => r.firstStart).filter((v): v is string => !!v).sort();
    const ends = group.map((r) => r.lastEnd).filter((v): v is string => !!v).sort();
    const hours =
      starts.length > 0 && ends.length > 0
        ? `${clock.format(new Date(starts[0]!))} – ${clock.format(new Date(ends[ends.length - 1]!))}`
        : null;
    out.push({
      key: `day:${first.date}:${first.ruleId}`,
      kind: "day",
      date: first.date,
      dates: [first.date],
      title: first.name?.trim() || "Special day",
      sub: [
        hours,
        plural(openings, "opening"),
        low === high ? money(low) : `${money(low)} – ${money(high)}`,
        booked > 0 ? `${booked} booked` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      target: { kind: "day", date: first.date, name: first.name ?? undefined },
    });
  }

  // One service's own hours on a date. Days set the same way are one row.
  for (const s of services) {
    const same = new Map<string, string[]>();
    for (const [date, entry] of Object.entries(s.dateHours ?? {})) {
      if (date < today) continue;
      // The same signature the calendar's bar groups by, so a change is one
      // thing in both places. A name is part of it: "Thanksgiving week" and
      // an unnamed day with the same hours are two changes.
      const sig = changeSignature(entry);
      same.set(sig, [...(same.get(sig) ?? []), date]);
    }
    for (const dates of same.values()) {
      dates.sort();
      const entry = s.dateHours![dates[0]!]!;
      const closed = entry.w.length === 0;
      const who = entry.staff.map(staffName).filter((n): n is string => !!n);
      const withWho = who.length > 0 ? `with ${few(who)}` : null;
      const called = (entry.n ?? "").trim();
      out.push({
        key: `hours:${s.id}:${dates[0]}`,
        kind: closed ? "closed" : "hours",
        date: dates[0]!,
        dates,
        // The name alone on top, the hours under it: a service's name plus
        // two time ranges ran to six lines on a phone.
        // A change the shop named goes by its name, the way a holiday does;
        // the service it is about moves down a line.
        title: called || (closed ? `${s.name} closed` : s.name),
        sub:
          [
            called ? (closed ? `${s.name} closed` : s.name) : null,
            closed ? null : spansLabel(entry.w.map((w) => ({ startMin: w.s, endMin: w.e }))),
            dates.length > 1 ? datesLabel(dates) : null,
            withWho,
          ]
            .filter(Boolean)
            .join(" · ") || "Not offered that day",
        target: { kind: "hours", serviceId: s.id },
      });
    }
  }

  // One-time openings. A weekly series is not a date, and a special day's
  // openings are already counted on its own row.
  const running = new Set(rules.map((r) => r.id));
  const byDay = new Map<string, TargetedSlotRow[]>();
  for (const t of slots) {
    // What is left of a series that was turned off (a booked visit) is listed:
    // the tool below shows it as a slot of its own, so this does too.
    if (t.ruleId !== null && running.has(t.ruleId)) continue;
    const date = zonedDateKey(new Date(t.startsAt), timezone);
    if (date < today) continue;
    byDay.set(date, [...(byDay.get(date) ?? []), t]);
  }
  for (const [date, list] of byDay) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const first = list[0]!;
    const times = list.map((t) => clock.format(new Date(t.startsAt)));
    const booked = list.filter((t) => t.booked).length;
    const off = list.filter((t) => !t.active && !t.booked).length;
    const state =
      list.length === 1
        ? booked === 1
          ? "Booked"
          : off === 1
            ? "Turned off"
            : null
        : [booked > 0 ? `${booked} booked` : null, off > 0 ? `${off} turned off` : null].filter(Boolean).join(", ") ||
          null;
    const servicesHere = [...new Set(list.map((t) => serviceName(t.serviceId)))];
    const pricesHere = [...new Set(list.map((t) => t.price))].sort((a, b) => a - b);
    out.push({
      key: `opening:${date}`,
      kind: "opening",
      date,
      dates: [date],
      title:
        list.length === 1
          ? `${first.label?.trim() || "One-time opening"}, ${times[0]}`
          : `${list.length} one-time openings`,
      sub: [
        list.length > 1 ? few(times, 3) : null,
        few(servicesHere),
        pricesHere.length === 1
          ? money(pricesHere[0]!)
          : `${money(pricesHere[0]!)} – ${money(pricesHere[pricesHere.length - 1]!)}`,
        state,
      ]
        .filter(Boolean)
        .join(" · "),
      target: { kind: "opening", slotId: first.id },
    });
  }

  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.title.localeCompare(b.title),
  );
}

/** The list cut into months, each named the way a calendar names it. */
export function byMonth(entries: SpecialDateEntry[], today: string): SpecialDateMonth[] {
  const thisYear = today.slice(0, 4);
  const out: SpecialDateMonth[] = [];
  for (const e of entries) {
    const key = e.date.slice(0, 7);
    let month = out[out.length - 1];
    if (!month || month.key !== key) {
      const name = MONTH_LONG[Number(key.slice(5, 7)) - 1]!;
      month = { key, label: key.slice(0, 4) === thisYear ? name : `${name} ${key.slice(0, 4)}`, entries: [] };
      out.push(month);
    }
    month.entries.push(e);
  }
  return out;
}
