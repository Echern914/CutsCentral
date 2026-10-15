/** The front desk as the team's owner sees it (GET /api/team/walk-ins). */
export type DeskReason = "not_taking" | "line_off" | "paused" | "no_access" | "no_services" | "no_staff";

export interface TeamDeskData {
  /** False while Walk-In Mode is off for the platform: nothing else is sent. */
  available: boolean;
  desk?: { on: boolean; acceptingNow: boolean; hasKiosk: boolean };
  members?: { linkId: string; business: { name: string }; taking: boolean; reason: DeskReason | null }[];
  line?: {
    id: string;
    business: { name: string };
    firstName: string;
    status: string;
    waitMin: number | null;
    joinedAt: string;
  }[];
}

/** Where a member stands with the desk, in plain words. */
export function deskReasonLine(reason: DeskReason | null): string {
  switch (reason) {
    case null:
      return "Taking walk-ins";
    case "not_taking":
      return "Not taking front-desk walk-ins";
    case "line_off":
      return "Their walk-in line is off";
    case "paused":
      return "Their walk-in line is paused";
    case "no_access":
      return "Their plan isn't active";
    case "no_services":
      return "No services set up";
    case "no_staff":
      return "No chair set up";
  }
}

/** A line entry's state, as the front desk would say it. */
export function deskStatusLine(status: string, waitMin: number | null): string {
  switch (status) {
    case "IN_SERVICE":
      return "In the chair";
    case "READY":
      return "Called up";
    case "ASSIGNED":
      return waitMin === null ? "Next up" : waitMin === 0 ? "Next up - now" : `Next up - about ${waitMin} min`;
    default:
      return waitMin === null ? "Waiting" : waitMin === 0 ? "Waiting - about now" : `Waiting - about ${waitMin} min`;
  }
}
