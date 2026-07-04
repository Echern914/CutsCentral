import { toE164 } from "../acuity/clientKey.js";
import type { GcalAttendee, GcalEvent } from "./types.js";

/**
 * Map a Google Calendar event to Visit/Client fields. This is the honest
 * weak point of the calendar bridge: unlike the Acuity/Square APIs, a calendar
 * event has no structured client record — Booksy/GlossGenius sync titles like
 * "Haircut - John Smith" and MAYBE a phone/email in the description or an
 * attendee. Everything here is best-effort extraction; a client with no
 * parseable contact becomes an anon:<slug> client (trackable for punches,
 * flagged un-nudgeable in the dashboard — same story as Acuity anon clients).
 */

export interface MappedGcalEvent {
  scheduledAt: Date;
  endAt: Date;
  serviceName: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null; // E.164
  email: string | null;
  /**
   * Name-ish seed for the anon client key when there's no phone/email/name:
   * parsed name || attendee display name || the raw title. Keeps distinct
   * titles from collapsing into one anon:unknown mega-client.
   */
  clientKeySeed: string;
}

/**
 * Should this LIVE event be ingested as a visit at all? Structured-field noise
 * filters only (no fragile text heuristics):
 *  - timed events only (all-day = birthdays/blocks/holidays, not bookings)
 *  - eventType "default" only (excludes outOfOffice/focusTime/workingLocation/
 *    birthday/fromGmail — Gmail-derived flights etc. are never bookings)
 *  - busy events only (transparency "transparent" = marked Free, an FYI overlay)
 *  - must have a title (an untitled event can't name a client or service)
 * Known residual noise: a barber's personal timed events ("Team meeting") DO
 * pass — they become anon clients that never redeem, an accepted v1 trade-off.
 */
export function shouldIngestGcalEvent(event: GcalEvent): boolean {
  if (event.status === "cancelled") return false; // tombstones take the cancel path
  if (!event.start?.dateTime || !event.end?.dateTime) return false;
  if (event.eventType && event.eventType !== "default") return false;
  if (event.transparency === "transparent") return false;
  if (!event.summary?.trim()) return false;
  return true;
}

/** Map a live, shouldIngest-approved event. Null when the times don't parse. */
export function mapGcalEvent(event: GcalEvent): MappedGcalEvent | null {
  const scheduledAt = parseDate(event.start?.dateTime);
  const endAt = parseDate(event.end?.dateTime);
  if (!scheduledAt || !endAt) return null;

  const summary = event.summary!.trim();
  const attendee = firstHumanAttendee(event.attendees);
  const { name, service } = splitSummary(summary, attendee?.displayName ?? null);

  const phone = findPhone(event.description) ?? findPhone(summary);
  const email = attendee?.email ?? findEmail(event.description);

  const fullName = name ?? attendee?.displayName?.trim() ?? null;
  const [firstName, lastName] = splitName(fullName);

  return {
    scheduledAt,
    endAt,
    serviceName: (service ?? summary).slice(0, 120),
    firstName,
    lastName,
    phone,
    email,
    clientKeySeed: fullName ?? summary,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The first attendee who could be the CLIENT: not the calendar owner (self),
 * not the organizer, not a room/equipment resource, and not a
 * *.calendar.google.com service address.
 */
function firstHumanAttendee(
  attendees: GcalAttendee[] | null | undefined,
): GcalAttendee | null {
  for (const a of attendees ?? []) {
    if (a.self || a.organizer || a.resource) continue;
    if (a.email && a.email.toLowerCase().endsWith("calendar.google.com")) continue;
    if (!a.email && !a.displayName) continue;
    return a;
  }
  return null;
}

// Separators booking platforms use between service and client in event titles.
// Checked in order; split happens at the FIRST occurrence of the winner.
const SEPARATORS = [" — ", " – ", " - ", ": ", " with ", " w/ "];

/**
 * Split "Haircut - John Smith" (or "John Smith - Haircut") into name + service.
 * The side that LOOKS like a person name (2-4 capitalizable words, no digits)
 * wins; the attendee display name breaks ties. When both or neither side looks
 * like a name, the platforms' dominant service-first convention picks the
 * RIGHT side as the client. No separator => the title is service-only.
 */
function splitSummary(
  summary: string,
  attendeeName: string | null,
): { name: string | null; service: string | null } {
  for (const sep of SEPARATORS) {
    const at = summary.indexOf(sep);
    if (at <= 0) continue;
    const a = summary.slice(0, at).trim();
    const b = summary.slice(at + sep.length).trim();
    if (!a || !b) continue;

    // An attendee display name matching one side settles it outright.
    if (attendeeName) {
      const want = attendeeName.trim().toLowerCase();
      if (a.toLowerCase() === want) return { name: a, service: b };
      if (b.toLowerCase() === want) return { name: b, service: a };
    }

    const aIsName = looksLikePersonName(a);
    const bIsName = looksLikePersonName(b);
    if (aIsName && !bIsName) return { name: a, service: b };
    if (bIsName && !aIsName) return { name: b, service: a };
    if (bIsName) return { name: b, service: a }; // both name-ish: service-first convention
    return { name: null, service: summary }; // neither — don't guess
  }
  return { name: null, service: summary };
}

/** "John Smith" / "Mary-Jane O'Brien" — 2-4 words, letters only, short. */
function looksLikePersonName(s: string): boolean {
  if (s.length > 40 || /\d/.test(s)) return false;
  return /^\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*){1,3}$/u.test(s);
}

function splitName(full: string | null): [string | null, string | null] {
  if (!full) return [null, null];
  const words = full.trim().split(/\s+/);
  if (words.length === 1) return [words[0]!, null];
  return [words[0]!, words.slice(1).join(" ")];
}

// US-shaped phone anywhere in free text (Booksy/GlossGenius put one in the
// description when they include contact at all). toE164 validates properly.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

function findPhone(text: string | null | undefined): string | null {
  const match = text?.match(PHONE_RE);
  return match ? toE164(match[0]) : null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function findEmail(text: string | null | undefined): string | null {
  const match = text?.match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}
