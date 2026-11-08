import { zonedDateKey, zonedDateParts, zonedMinutesOfDay } from "@chairback/config/time";

/**
 * 🔴 AN UNBOOKED TARGETED SLOT HOLDS ITS TIME AGAINST EVERY SERVICE. The slot
 * engine (apps/api engines/slots.ts) subtracts it from the staff member's grid
 * whatever it sells, so a service window can be saved correctly and still never
 * show a time. Drick, 2026-11-08: a 90 minute service set to Mon 7:00-8:30 PM
 * showed nothing at 7:00, because a 30 minute haircut slot at 8:00 PM sat inside
 * it. Nothing on the screen said so.
 *
 * This repeats the engine's arithmetic for one window on one date: starts step
 * by the service length from the start of each free stretch. It reads only what
 * the editor has, so it can miss a clash the shop's turnover buffer causes, and
 * it never reports one the targeted slots don't explain.
 */
export interface HoursWindowMin {
  startMin: number;
  endMin: number;
}

export interface TargetedSlotForHours {
  staffId: string;
  serviceId: string;
  serviceIds?: string[];
  label: string | null;
  startsAt: string;
  durationMin: number;
  active: boolean;
  booked: boolean;
}

export interface TargetedSlotHoursConflict {
  weekday: number;
  staffId: string;
  /** The start this service loses, in shop-local minutes. */
  lostStartMin: number;
  slotStartMin: number;
  slotLabel: string | null;
  /** The next date it happens, as YYYY-MM-DD. */
  nextDate: string;
}

function startsIn(startMin: number, endMin: number, durationMin: number): number[] {
  const out: number[] = [];
  for (let t = startMin; t + durationMin <= endMin; t += durationMin) out.push(t);
  return out;
}

type Held = { startMin: number; endMin: number; label: string | null; sellsThisService: boolean };

/** The window's starts once these slots are taken out of it. */
function startsAround(window: HoursWindowMin, held: Held[], durationMin: number): Set<number> {
  const offered = new Set<number>();
  let cursor = window.startMin;
  const inOrder = [...held].sort((a, b) => a.startMin - b.startMin);
  for (const h of inOrder) {
    if (h.endMin <= cursor || h.startMin >= window.endMin) continue;
    for (const t of startsIn(cursor, Math.min(h.startMin, window.endMin), durationMin)) offered.add(t);
    cursor = Math.max(cursor, h.endMin);
  }
  for (const t of startsIn(cursor, window.endMin, durationMin)) offered.add(t);
  return offered;
}

export function targetedSlotHoursConflicts(input: {
  windowsByDay: Record<number, HoursWindowMin[]>;
  /** The service's length that weekday. */
  durationFor: (weekday: number) => number;
  slots: TargetedSlotForHours[];
  serviceId: string;
  staffIds: string[];
  timezone: string;
}): TargetedSlotHoursConflict[] {
  const { windowsByDay, durationFor, slots, serviceId, staffIds, timezone } = input;

  const byStaffDate = new Map<
    string,
    { staffId: string; date: string; weekday: number; held: Held[] }
  >();
  for (const s of slots) {
    if (!s.active || s.booked || !staffIds.includes(s.staffId)) continue;
    const at = new Date(s.startsAt);
    const date = zonedDateKey(at, timezone);
    const { year, month0, day } = zonedDateParts(at, timezone);
    const startMin = zonedMinutesOfDay(at, timezone);
    const key = `${s.staffId}|${date}`;
    const entry = byStaffDate.get(key) ?? {
      staffId: s.staffId,
      date,
      weekday: new Date(Date.UTC(year, month0, day)).getUTCDay(),
      held: [],
    };
    entry.held.push({
      startMin,
      endMin: startMin + s.durationMin,
      label: s.label,
      sellsThisService: s.serviceId === serviceId || (s.serviceIds ?? []).includes(serviceId),
    });
    byStaffDate.set(key, entry);
  }

  const seen = new Set<string>();
  const conflicts: TargetedSlotHoursConflict[] = [];
  const earliestFirst = [...byStaffDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const { staffId, date, weekday, held } of earliestFirst) {
    const durationMin = durationFor(weekday);
    if (!(durationMin > 0)) continue;
    for (const window of windowsByDay[weekday] ?? []) {
      const offered = startsAround(window, held, durationMin);
      // A slot selling THIS service at the same start still offers that time,
      // at its own price, so the customer loses nothing there.
      const lost = startsIn(window.startMin, window.endMin, durationMin).find(
        (t) => !offered.has(t) && !held.some((h) => h.startMin === t && h.sellsThisService),
      );
      if (lost === undefined) continue;
      const key = `${staffId}|${weekday}|${window.startMin}|${lost}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inTheWay =
        held.find((h) => h.startMin < lost + durationMin && h.endMin > lost) ??
        held.find((h) => h.startMin < window.endMin && h.endMin > window.startMin);
      if (!inTheWay) continue;
      conflicts.push({
        weekday,
        staffId,
        lostStartMin: lost,
        slotStartMin: inTheWay.startMin,
        slotLabel: inTheWay.label,
        nextDate: date,
      });
    }
  }
  return conflicts.sort(
    (a, b) => a.weekday - b.weekday || a.lostStartMin - b.lostStartMin,
  );
}
