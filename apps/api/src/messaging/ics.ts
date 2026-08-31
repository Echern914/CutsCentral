/**
 * iCalendar (.ics) for one appointment - the "Add to Calendar" that works for
 * EVERYBODY: Apple Calendar, Google Calendar and Outlook all open a .ics
 * natively, no vendor account, no certificate, no per-platform link. The
 * Apple Wallet pass (wallet/appointmentPass.ts) is the richer iOS-only
 * companion; this is the floor every customer gets.
 *
 * RFC 5545 rules that actually bite:
 *  - Lines end CRLF, and any line over 75 octets is FOLDED (continuation
 *    lines start with one space). Google accepts long lines; Apple Calendar
 *    quietly truncates properties on some versions - fold, always.
 *  - TEXT values escape backslash, semicolon, comma and newline. A service
 *    named "Cut, Fade; Special" must not become three properties.
 *  - UID is the event's IDENTITY across imports: keep it stable per
 *    appointment so re-adding after a reschedule UPDATES the entry instead of
 *    duplicating it, and let SEQUENCE rise so clients accept the change.
 *  - Times are emitted in UTC ("Z" form). The customer's calendar renders
 *    them in their own timezone - which is the right behavior for a person
 *    who books from out of town.
 */

/** Escape one TEXT value per RFC 5545 §3.3.11. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** "2026-06-28T18:30:00.000Z" -> "20260628T183000Z" */
export function icsUtc(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Fold one content line to 75-octet segments (RFC 5545 §3.1). Folding is by
 * BYTES, not characters - a name full of emoji must not split a code point,
 * so we fold on UTF-8 boundaries under the limit.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    // Continuation lines carry a leading space, costing one octet.
    let limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Back off to a UTF-8 boundary (never split inside a multi-byte char).
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return parts.join("\r\n");
}

export interface AppointmentIcsInput {
  /** Stable identity: the UID is derived from this, never from a token. */
  appointmentId: string;
  serviceName: string;
  shopName: string;
  startsAt: Date;
  endsAt: Date;
  staffName?: string | null;
  /** Street address lines when the shop has one; falls back to the shop name. */
  addressLines?: Array<string | null | undefined>;
  /** The manage page - the one link a customer may act on. */
  manageUrl: string;
  /**
   * Rises when the appointment's TIME changes, so a re-imported file replaces
   * the old entry. Callers pass a value derived from the current state (we use
   * the updatedAt epoch minute) - it only needs to be >= the previous import's.
   */
  sequence: number;
}

/** Build the complete .ics document (CRLF, folded, escaped). */
export function buildAppointmentIcs(input: AppointmentIcsInput): string {
  const location = (input.addressLines ?? [])
    .map((l) => l?.trim())
    .filter((l): l is string => Boolean(l))
    .join(", ");
  const summary = `${input.serviceName} at ${input.shopName}`;
  const description = [
    input.staffName ? `With ${input.staffName}.` : null,
    `Need to reschedule or cancel? ${input.manageUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ChairBack//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(input.appointmentId)}@getchairback.com`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
    `DTSTAMP:${icsUtc(new Date(input.startsAt))}`,
    `DTSTART:${icsUtc(input.startsAt)}`,
    `DTEND:${icsUtc(input.endsAt)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    ...(location ? [`LOCATION:${escapeIcsText(location)}`] : []),
    `DESCRIPTION:${escapeIcsText(description)}`,
    `URL:${input.manageUrl}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
