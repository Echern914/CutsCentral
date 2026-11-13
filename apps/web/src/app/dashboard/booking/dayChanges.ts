import { spansLabel } from "@chairback/config/dateHoursPlan";

/**
 * A SERVICE'S OWN HOURS ON A DATE, as the calendar shows it.
 *
 * "Change some days" saves one entry per date. A barber does not think of it
 * that way: Monday to Friday of a holiday week is ONE change, made once. So
 * the days of a service that were set the same way (same hours, same people,
 * same name) are one change here, and the calendar's bar, its sheet and the
 * Special dates list all speak about that one thing.
 *
 * Pure, and "today" is a parameter: a passed date is not a change any more
 * (the server drops it on the next save and will not let it be edited), and a
 * test must not go red on a calendar date.
 */

export interface StoredDayHours {
  w: { s: number; e: number }[];
  staff: string[];
  /** What the shop calls the change. Its own label; a client is never sent it. */
  n?: string;
}

export interface ChangeService {
  id: string;
  name: string;
  dateHours?: Record<string, StoredDayHours>;
  dateOverrides?: Record<string, number>;
}

export interface DayChange {
  serviceId: string;
  serviceName: string;
  /** Every day, today or later, this service is set the same way. Sorted. */
  dates: string[];
  /** [] = not offered those days. */
  hours: { s: number; e: number }[];
  /** [] = everyone who does the service. */
  staffIds: string[];
  name: string | null;
  /** The one price those days share, when they share one. */
  price: number | null;
}

/** Two days with the same signature are the same change. */
export function changeSignature(entry: StoredDayHours): string {
  return JSON.stringify([entry.w.map((w) => [w.s, w.e]), [...entry.staff].sort(), (entry.n ?? "").trim()]);
}

/** The changes in force on one day, in the order the services were given. */
export function changesOn(services: readonly ChangeService[], dateKey: string, today: string): DayChange[] {
  if (dateKey < today) return [];
  const out: DayChange[] = [];
  for (const s of services) {
    const entry = s.dateHours?.[dateKey];
    if (!entry) continue;
    const sig = changeSignature(entry);
    const dates = Object.entries(s.dateHours ?? {})
      .filter(([date, other]) => date >= today && changeSignature(other) === sig)
      .map(([date]) => date)
      .sort();
    const prices = [...new Set(dates.map((d) => s.dateOverrides?.[d]))];
    const only = prices.length === 1 ? prices[0] : undefined;
    out.push({
      serviceId: s.id,
      serviceName: s.name,
      dates,
      hours: entry.w,
      staffIds: entry.staff,
      name: (entry.n ?? "").trim() || null,
      price: only === undefined ? null : only,
    });
  }
  return out;
}

/** Every day, today or later, on which some service runs its own hours. */
export function changedDays(services: readonly ChangeService[], today: string): Set<string> {
  const out = new Set<string>();
  for (const s of services) {
    for (const date of Object.keys(s.dateHours ?? {})) if (date >= today) out.add(date);
  }
  return out;
}

/** The change's own name, or the service it is about. */
export function changeTitle(change: DayChange): string {
  if (change.name) return change.name;
  return change.hours.length === 0 ? `${change.serviceName} closed` : change.serviceName;
}

/** The line under the title: what is different, in a few words. */
export function changeSub(change: DayChange, staffNames: readonly string[] = []): string {
  const closed = change.hours.length === 0;
  const hours = closed ? null : spansLabel(change.hours.map((w) => ({ startMin: w.s, endMin: w.e })));
  const who = staffNames.length > 0 ? `with ${staffNames.join(", ")}` : null;
  if (change.name) {
    return [change.serviceName, hours ?? "not offered", who].filter(Boolean).join(" · ");
  }
  return [closed ? "Not offered this day" : `Own hours: ${hours}`, who].filter(Boolean).join(" · ");
}

/**
 * The hours of the day the planner must draw so that every changed hour has a
 * row. The planner starts at its usual first hour; a service opened at 6 AM
 * would otherwise have no row to book into.
 */
export function changeHours(changes: readonly DayChange[]): number[] {
  const out: number[] = [];
  for (const c of changes) {
    for (const w of c.hours) {
      if (w.e <= w.s) continue;
      out.push(Math.floor(w.s / 60), Math.min(23, Math.floor((w.e - 1) / 60)));
    }
  }
  return out;
}
