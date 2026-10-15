import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { TeamDeskData } from "@/lib/teamWalkIns";

/**
 * The owner's front desk card. What must hold:
 *  - it says whether the desk is set up, and where to set it up;
 *  - each member reads as taking walk-ins, or why not;
 *  - the line is first names, who for, and the wait - read again on refresh;
 *  - with Walk-In Mode off for the platform it renders nothing at all.
 */
const teamWalkInsAction = vi.fn();
vi.mock("./actions", () => ({ teamWalkInsAction: (...a: unknown[]) => teamWalkInsAction(...a) }));

const { TeamWalkIns } = await import("./TeamWalkIns");
const { deskStatusLine } = await import("@/lib/teamWalkIns");
const vocab = vocabularyFor("barber");

function desk(over: Partial<TeamDeskData> = {}): TeamDeskData {
  return {
    available: true,
    desk: { on: true, acceptingNow: true, hasKiosk: true },
    members: [
      { linkId: "l1", business: { name: "Chris Clipz" }, taking: true, reason: null },
      { linkId: "l2", business: { name: "Jay Blendz" }, taking: true, reason: "line_off" },
      { linkId: "l3", business: { name: "Kim Cuts" }, taking: false, reason: "not_taking" },
    ],
    line: [
      { id: "e1", business: { name: "Chris Clipz" }, firstName: "Dee", status: "WAITING", waitMin: 12, joinedAt: "2027-01-14T10:00:00.000Z" },
      { id: "e2", business: { name: "Chris Clipz" }, firstName: "Sam", status: "IN_SERVICE", waitMin: 0, joinedAt: "2027-01-14T09:40:00.000Z" },
    ],
    ...over,
  };
}

beforeEach(() => teamWalkInsAction.mockReset());

describe("TeamWalkIns", () => {
  it("who takes the desk's walk-ins, and why not", () => {
    render(<TeamWalkIns initial={desk()} vocab={vocab} />);
    const rows = Array.from(document.querySelectorAll('[data-qa="desk-members"] li')).map((li) => li.textContent);
    expect(rows).toEqual([
      "Chris ClipzTaking walk-ins",
      "Jay BlendzTheir walk-in line is off",
      "Kim CutsNot taking front-desk walk-ins",
    ]);
  });

  it("the line: first name, who for, and the wait", () => {
    render(<TeamWalkIns initial={desk()} vocab={vocab} />);
    const line = document.querySelector('[data-qa="desk-line"]')!.textContent!;
    expect(line).toContain("Dee · Chris Clipz");
    expect(line).toContain("Waiting - about 12 min");
    expect(line).toContain("In the chair");
  });

  it("an empty line says so", () => {
    render(<TeamWalkIns initial={desk({ line: [] })} vocab={vocab} />);
    expect(screen.getByText("No one waiting.")).toBeTruthy();
  });

  it("a desk not set up points to Booking settings", () => {
    render(<TeamWalkIns initial={desk({ desk: { on: false, acceptingNow: true, hasKiosk: false } })} vocab={vocab} />);
    const setup = document.querySelector('[data-qa="desk-setup"]')!;
    expect(setup.textContent).toContain("Your walk-ins are off.");
    expect(setup.querySelector("a")!.getAttribute("href")).toBe("/dashboard/booking?tab=Settings");
  });

  it("Refresh reads the line again", async () => {
    teamWalkInsAction.mockResolvedValue(desk({ line: [] }));
    render(<TeamWalkIns initial={desk()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("No one waiting.")).toBeTruthy());
  });

  it("a change to the team re-reads it", async () => {
    teamWalkInsAction.mockResolvedValue(desk({ line: [] }));
    const { rerender } = render(<TeamWalkIns initial={desk()} vocab={vocab} version={0} />);
    expect(teamWalkInsAction).not.toHaveBeenCalled();
    await act(async () => {
      rerender(<TeamWalkIns initial={desk()} vocab={vocab} version={1} />);
    });
    expect(teamWalkInsAction).toHaveBeenCalledTimes(1);
  });

  it("Walk-In Mode off for the platform: nothing at all", () => {
    const { container } = render(<TeamWalkIns initial={{ available: false }} vocab={vocab} />);
    expect(container.innerHTML).toBe("");
  });

  it("status words", () => {
    expect(deskStatusLine("WAITING", null)).toBe("Waiting");
    expect(deskStatusLine("WAITING", 0)).toBe("Waiting - about now");
    expect(deskStatusLine("ASSIGNED", 5)).toBe("Next up - about 5 min");
    expect(deskStatusLine("READY", 0)).toBe("Called up");
  });
});
