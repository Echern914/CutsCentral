import type { VisitStatus } from "@chairback/db";
import type { AcuityAppointment } from "./types.js";

/**
 * Resolve a Visit status from the fetched appointment + the webhook action.
 * The action is advisory (bare values: scheduled/rescheduled/canceled/changed);
 * we trust the appointment's own flags (canceled, noShow) over the verb.
 */
export function resolveStatus(
  appt: AcuityAppointment,
  action: string,
): VisitStatus {
  if (appt.canceled) {
    return appt.noShow ? "NO_SHOW" : "CANCELED";
  }
  if (action === "rescheduled") return "RESCHEDULED";
  // scheduled / changed / anything else with a live appointment → SCHEDULED.
  // The status-promotion job later flips past-end visits to COMPLETED.
  return "SCHEDULED";
}
