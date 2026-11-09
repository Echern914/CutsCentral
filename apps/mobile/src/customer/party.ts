import { dayLabel, timeLabel } from "./format";
import type { Appointment } from "./types";

/**
 * Appointments booked together - a parent booking for two or three kids - read
 * as one thing with a drop-down, instead of three rows nobody can tell apart.
 * The API says who belongs together (`partyKey`) and who each seat is for
 * (`personName`). This file only decides how that reads.
 *
 * An API older than this app sends neither, and every row stays on its own.
 */

export type HistoryEntry<T> = { kind: "one"; appt: T } | { kind: "party"; key: string; members: T[] };

type PartyRow = Pick<Appointment, "startsAt" | "partyKey">;

/**
 * Folds a list into single rows and parties, keeping the list's order: a party
 * sits where its first member appeared. Inside a party the members always run
 * soonest first, even in a newest-first list, because that is the order they sit
 * in the chair. A party with one member left is an ordinary row.
 */
export function groupIntoParties<T extends PartyRow>(items: T[]): HistoryEntry<T>[] {
  const byKey = new Map<string, T[]>();
  for (const a of items) {
    if (!a.partyKey) continue;
    byKey.set(a.partyKey, [...(byKey.get(a.partyKey) ?? []), a]);
  }

  const out: HistoryEntry<T>[] = [];
  const placed = new Set<string>();
  for (const a of items) {
    const members = a.partyKey ? byKey.get(a.partyKey) : undefined;
    if (!a.partyKey || !members || members.length < 2) {
      out.push({ kind: "one", appt: a });
      continue;
    }
    if (placed.has(a.partyKey)) continue;
    placed.add(a.partyKey);
    out.push({
      kind: "party",
      key: a.partyKey,
      members: [...members].sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt)),
    });
  }
  return out;
}

/** "3 appointments" */
export function partyCount(members: unknown[]): string {
  return `${members.length} appointments`;
}

/** "3 appointments · Today at 3:00 PM" */
export function partySummary(members: Appointment[], now = new Date()): string {
  const first = members[0]!;
  return `${partyCount(members)} · ${dayLabel(first.startsAt, first.timezone, now)} at ${timeLabel(first.startsAt, first.timezone)}`;
}

/**
 * "Mia, Leo and Sam". Each name once, because one person can hold several seats
 * in a run. Empty when nobody's name is known.
 */
export function partyNames(members: Pick<Appointment, "personName">[]): string {
  const names = [...new Set(members.map((m) => m.personName?.trim()).filter((n): n is string => Boolean(n)))];
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The status every member shares, or null when they differ and each must say its own. */
export function sharedStatus(
  members: Pick<Appointment, "status" | "statusLabel" | "statusDetail">[],
): Pick<Appointment, "status" | "statusLabel" | "statusDetail"> | null {
  const first = members[0];
  if (!first) return null;
  return members.every((m) => m.status === first.status && m.statusLabel === first.statusLabel) ? first : null;
}

/** The title of one person's row. Their name leads, because the service alone can't say whose it is. */
export function seatTitle(appt: Pick<Appointment, "personName" | "serviceName">): string {
  const service = appt.serviceName ?? "Appointment";
  return appt.personName ? `${appt.personName} · ${service}` : service;
}
