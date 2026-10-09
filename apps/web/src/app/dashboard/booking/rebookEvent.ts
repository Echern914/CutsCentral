import type { RebookFrom } from "./AppointmentForm";

/**
 * "Book again" from an appointment's Full details. The sheet lives deep inside
 * the calendar's rows, and the New appointment form is mounted by the calendar
 * itself - so, like the waitlist board's Book button, the sheet hands over with
 * a window event rather than threading a callback through every row. ONE
 * booking form in the app; the event only says whose next visit to start.
 */
export const REBOOK_EVENT = "cb:rebook-appointment";

export function requestRebook(detail: RebookFrom): void {
  window.dispatchEvent(new CustomEvent<RebookFrom>(REBOOK_EVENT, { detail }));
}
