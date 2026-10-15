import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { ChairDay, TeamScheduleData } from "@/lib/teamSchedule";

/**
 * The owner's Team schedule. What must hold:
 *  - only members who share are drawn; the rest are named as not shared;
 *  - each shown chair says where they are now, their hours and when they're free;
 *  - another day is read from the server, and a failed read keeps what's shown;
 *  - a change to the team (someone removed) re-reads the day on screen.
 */
const teamScheduleAction = vi.fn();
const toast = vi.fn();
vi.mock("./actions", () => ({
  teamScheduleAction: (...a: unknown[]) => teamScheduleAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { TeamSchedule } = await import("./TeamSchedule");
const { barRange, dayChipLabel, dayLine, nowLabel } = await import("@/lib/teamSchedule");
const vocab = vocabularyFor("barber");

const t = (hhmm: string, day = "2027-01-14") => `${day}T${hhmm}:00.000Z`;
const s = (a: string, b: string, day?: string) => ({ start: t(a, day), end: t(b, day) });

function chair(over: Partial<ChairDay> = {}): ChairDay {
  return {
    name: "Chris",
    hours: [s("09:00", "17:00")],
    booked: [s("13:00", "13:30")],
    off: [s("12:00", "12:30")],
    free: [s("09:00", "12:00"), s("12:30", "13:00"), s("13:30", "17:00")],
    now: { kind: "free", until: t("12:00") },
    ...over,
  };
}

function data(over: Partial<TeamScheduleData> = {}): TeamScheduleData {
  return {
    timezone: "UTC",
    day: "2027-01-14",
    days: ["2027-01-14", "2027-01-15", "2027-01-16", "2027-01-17", "2027-01-18", "2027-01-19", "2027-01-20"],
    now: t("10:00"),
    members: [
      { linkId: "l1", business: { name: "Chris Clipz" }, shared: true, chairs: [chair()] },
      { linkId: "l2", business: { name: "Jay Blendz" }, shared: false, chairs: null },
    ],
    ...over,
  };
}

beforeEach(() => {
  teamScheduleAction.mockReset();
  toast.mockReset();
});

describe("TeamSchedule", () => {
  it("draws a member who shares; names one who doesn't", () => {
    render(<TeamSchedule initial={data()} vocab={vocab} />);
    const row = screen.getByText("Chris Clipz").closest("[data-qa=schedule-member]") as HTMLElement;
    expect(within(row).getByText("Free until 12:00 PM")).toBeTruthy();
    expect(within(row).getByText("9:00 AM - 5:00 PM · 1 booked")).toBeTruthy();
    expect(row.textContent).toContain("Free 9:00 AM - 12:00 PM, 12:30 PM - 1:00 PM, 1:30 PM - 5:00 PM");
    expect(screen.getByText("Not shared: Jay Blendz.")).toBeTruthy();
    expect(screen.queryAllByText(/Jay Blendz/).length).toBe(1);
  });

  it("with no one sharing, it says how a barber turns it on", () => {
    render(
      <TeamSchedule
        initial={data({ members: [{ linkId: "l2", business: { name: "Jay Blendz" }, shared: false, chairs: null }] })}
        vocab={vocab}
      />,
    );
    expect(screen.getByText(/No one shares their schedule yet/)).toBeTruthy();
  });

  it("picking a day reads it from the server", async () => {
    teamScheduleAction.mockResolvedValue(
      data({
        day: "2027-01-16",
        members: [
          { linkId: "l1", business: { name: "Chris Clipz" }, shared: true, chairs: [chair({ hours: [], booked: [], off: [], free: [], now: null })] },
        ],
      }),
    );
    render(<TeamSchedule initial={data()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: dayChipLabel("2027-01-16", 2) }));
    expect(teamScheduleAction).toHaveBeenCalledWith("2027-01-16");
    await waitFor(() => expect(screen.getByText("Off")).toBeTruthy());
    expect(screen.getByRole("button", { name: dayChipLabel("2027-01-16", 2) }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a failed read keeps the day shown and says so", async () => {
    teamScheduleAction.mockResolvedValue(null);
    render(<TeamSchedule initial={data()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't load that day - try again", "error"));
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Free until 12:00 PM")).toBeTruthy();
  });

  it("a change to the team re-reads the day on screen", async () => {
    teamScheduleAction.mockResolvedValue(data({ members: [] }));
    const { rerender } = render(<TeamSchedule initial={data()} vocab={vocab} version={0} />);
    expect(teamScheduleAction).not.toHaveBeenCalled();
    await act(async () => {
      rerender(<TeamSchedule initial={data()} vocab={vocab} version={1} />);
    });
    expect(teamScheduleAction).toHaveBeenCalledWith("2027-01-14");
    await waitFor(() => expect(screen.queryByText("Chris Clipz")).toBeNull());
  });
});

describe("schedule words", () => {
  it("where they are now", () => {
    expect(nowLabel({ kind: "busy", until: t("13:30") }, "UTC")).toEqual({ text: "Booked until 1:30 PM", tone: "busy" });
    expect(nowLabel({ kind: "away", until: t("12:30") }, "UTC").text).toBe("Away until 12:30 PM");
    expect(nowLabel({ kind: "starts", at: t("09:00") }, "UTC").text).toBe("In at 9:00 AM");
    expect(nowLabel({ kind: "done" }, "UTC").text).toBe("Done for the day");
    expect(nowLabel({ kind: "off" }, "UTC").text).toBe("Off today");
    // Read in the TEAM's zone: 14:00 UTC is 9:00 AM in Chicago in January.
    expect(nowLabel({ kind: "free", until: t("14:00") }, "America/Chicago").text).toBe("Free until 8:00 AM");
  });

  it("the day line", () => {
    expect(dayLine(chair({ booked: [] }), "UTC")).toBe("9:00 AM - 5:00 PM · nothing booked");
    expect(dayLine(chair({ hours: [], booked: [] }), "UTC")).toBe("Off");
    expect(dayLine(chair({ hours: [] }), "UTC")).toBe("Not working - 1 booked");
  });

  it("day chips are the team's own dates", () => {
    expect(dayChipLabel("2027-01-14", 0)).toBe("Today");
    expect(dayChipLabel("2027-01-15", 1)).toBe("Tomorrow");
    expect(dayChipLabel("2027-01-16", 2)).toBe("Sat 16");
  });

  it("one scale for every bar, to whole hours; none when nothing is on", () => {
    const r = barRange([chair({ hours: [s("09:30", "17:00")] }), chair({ hours: [s("10:00", "18:15")], booked: [] })]);
    expect(r).toEqual({ from: Date.parse(t("09:00")), to: Date.parse(t("19:00")) });
    expect(barRange([chair({ hours: [], booked: [] })])).toBeNull();
  });
});
