import { SERVICE_COLORS } from "@chairback/config/constants";
import { isHiddenService } from "@chairback/config/serviceVisibility";
import type { AddOnRow, ServiceRow } from "./page";

/**
 * The one-service page shows every setting as a row with what it is set to
 * RIGHT NOW, so a barber can read a whole service without opening anything.
 * These turn each setting into those few words.
 *
 * They read the page's DRAFT (the boxes hold text until Save), so a row says
 * what Save is about to write, not what the server held when the page opened.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Two, then a count: a row has room for a few words, not a list. */
export function fewOf(items: string[], max = 2): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

/** "9 PM", "9:30 PM"; 24:00 is the end of the day. */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || m === undefined || !Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  if (h === 24) return "midnight";
  const half = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${half}` : `${h12}:${String(m).padStart(2, "0")} ${half}`;
}

/** A price and/or a length, as typed: "$55", "20 min", "$55 / 20 min". */
function change(price: string | undefined, minutes: string | undefined): string {
  const p = (price ?? "").trim();
  const m = (minutes ?? "").trim();
  return [p ? `$${p}` : "", m ? `${m} min` : ""].filter(Boolean).join(" / ");
}

export function whoValue(offeredByAll: boolean, names: string[]): string {
  if (offeredByAll) return "Everyone";
  if (names.length === 0) return "Nobody picked";
  return fewOf(names);
}

export function detailsValue(description: string, imageUrl: string): string {
  const d = description.trim() !== "";
  const p = imageUrl.trim() !== "";
  if (d && p) return "Description and photo";
  if (d) return "Description";
  if (p) return "Photo";
  return "None";
}

export function colorValue(color: string | null): string {
  if (!color) return "None";
  return (SERVICE_COLORS as Record<string, { label: string }>)[color]?.label ?? "None";
}

/** "No limit", or the days that have one: "Sat 8, Sun 4". */
export function limitsValue(limits: Record<number, string>): string {
  const set = WEEKDAYS.flatMap((day, wd) => {
    const v = (limits[wd] ?? "").trim();
    return v ? [`${day} ${v}`] : [];
  });
  return set.length === 0 ? "No limit" : fewOf(set);
}

/** "Same every day", or the days that differ: "Sun $55", "Fri 20 min". */
export function byDayValue(
  prices: Record<number, string>,
  minutes: Record<number, string>,
): string {
  const set = WEEKDAYS.flatMap((day, wd) => {
    const c = change(prices[wd], minutes[wd]);
    return c ? [`${day} ${c}`] : [];
  });
  return set.length === 0 ? "Same every day" : fewOf(set, 1);
}

/** "None", or the first window: "9 PM-11 PM $60". */
export function byTimeValue(
  rows: { start: string; end: string; price: string; durationMin: string }[],
): string {
  const set = rows.map((r) => {
    const span = `${clock(r.start)}-${clock(r.end)}`;
    const c = change(r.price, r.durationMin);
    return c ? `${span} ${c}` : span;
  });
  return set.length === 0 ? "None" : fewOf(set, 1);
}

/** "None", or the next date that has its own price: "Nov 26 $60". */
export function datePricesValue(rows: { date: string; price: string }[], today: string): string {
  const set = rows
    .filter((r) => r.date >= today && r.price.trim() !== "")
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => `${MONTHS[Number(r.date.slice(5, 7)) - 1] ?? ""} ${Number(r.date.slice(8))} $${r.price.trim()}`);
  return set.length === 0 ? "None" : fewOf(set, 1);
}

/**
 * The add-ons a client is offered with this service. An add-on with no
 * services listed goes with every service.
 */
export function addOnsValue(addOns: Pick<AddOnRow, "name" | "serviceIds" | "active">[], serviceId: string): string {
  const names = addOns
    .filter((a) => a.active && (a.serviceIds.length === 0 || a.serviceIds.includes(serviceId)))
    .map((a) => a.name);
  return names.length === 0 ? "None" : fewOf(names);
}

/**
 * Everything a copy of a service starts with: "<name> copy" carrying the
 * prices, lengths, hours, limits and who does it.
 *
 * Two things are deliberate. Group membership is NOT copied - a copy starts
 * on its own so it cannot silently join the original's booking limits. And a
 * hidden service's copy stays hidden: the API makes a new service public, so
 * without this a private service's copy went straight onto the booking page.
 */
export function duplicatePayload(s: ServiceRow) {
  return {
    // The column holds 120 characters - a long name must not make its copy fail.
    name: `${s.name.slice(0, 115)} copy`,
    description: s.description ?? undefined,
    imageUrl: s.imageUrl ?? undefined,
    durationMin: s.durationMin,
    price: s.price,
    priceOverrides: s.priceOverrides ?? undefined,
    durationOverrides: s.durationOverrides ?? undefined,
    dailyLimits: s.dailyLimits ?? undefined,
    dateOverrides: s.dateOverrides ?? undefined,
    hoursWindows: s.hoursWindows ?? undefined,
    timeOverrides: s.timeOverrides ?? undefined,
    color: s.color ?? null,
    dailyTarget: s.dailyTarget ?? null,
    offeredByAll: s.offeredByAll ?? false,
    staffIds: s.offeredByAll ? undefined : (s.staffIds ?? []),
    visibility: isHiddenService(s) ? ("hidden" as const) : ("public" as const),
  };
}
