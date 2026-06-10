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
  // Acuity marks no-shows WITHOUT canceling the appointment, so check the flag
  // first - otherwise a no-show stays SCHEDULED, gets promoted to COMPLETED,
  // and earns a loyalty punch for a visit that never happened.
  if (appt.noShow) return "NO_SHOW";
  if (appt.canceled) return "CANCELED";
  if (action === "rescheduled") return "RESCHEDULED";
  // scheduled / changed / anything else with a live appointment becomes SCHEDULED.
  // The status-promotion job later flips past-end visits to COMPLETED.
  return "SCHEDULED";
}
