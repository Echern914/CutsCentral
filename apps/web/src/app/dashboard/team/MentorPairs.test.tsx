import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The owner pairs mentors. What must hold:
 *  - the owner picks a mentor and who they mentor from the team, never the
 *    same person twice;
 *  - success is said only once the server agreed, then the team is re-read;
 *  - the pairs show names and dates - never a student's numbers.
 */
const pairMentorAction = vi.fn();
const endPairingAction = vi.fn();
const toast = vi.fn();
vi.mock("./actions", () => ({
  pairMentorAction: (...a: unknown[]) => pairMentorAction(...a),
  endPairingAction: (...a: unknown[]) => endPairingAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { MentorPairs } = await import("./MentorPairs");
const members = [
  { linkId: "l-will", name: "Will Fades" },
  { linkId: "l-chris", name: "Chris Clipz" },
  { linkId: "l-jay", name: "Jay Blendz" },
];
const onChanged = vi.fn(async () => {});

beforeEach(() => {
  pairMentorAction.mockReset();
  endPairingAction.mockReset();
  toast.mockReset();
  onChanged.mockClear();
});

describe("pairing", () => {
  it("🔴 pairs the two picked, says so after the server agreed, and re-reads the team", async () => {
    pairMentorAction.mockResolvedValue({ ok: true });
    render(<MentorPairs members={members} pairings={[]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Mentor"), { target: { value: "l-will" } });
    // The mentor isn't offered as their own student.
    expect([...(screen.getByLabelText("Student") as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      "",
      "l-chris",
      "l-jay",
    ]);
    fireEvent.change(screen.getByLabelText("Student"), { target: { value: "l-chris" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(pairMentorAction).toHaveBeenCalledWith("l-will", "l-chris");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Will Fades now mentors Chris Clipz", "success"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("Pair waits for both picks", () => {
    render(<MentorPairs members={members} pairings={[]} onChanged={onChanged} />);
    expect((screen.getByRole("button", { name: "Pair" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains an existing pairing rather than a vague failure", async () => {
    pairMentorAction.mockResolvedValue({ ok: false, error: "already_paired" });
    render(<MentorPairs members={members} pairings={[]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Mentor"), { target: { value: "l-will" } });
    fireEvent.change(screen.getByLabelText("Student"), { target: { value: "l-jay" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("They're already paired", "error"));
  });
});

describe("the pairs", () => {
  const pairings = [
    {
      id: "p1",
      mentor: { linkId: "l-will", name: "Will Fades" },
      student: { linkId: "l-chris", name: "Chris Clipz" },
      since: "2026-10-15T12:00:00.000Z",
    },
  ];

  it("🔴 names and dates only - never a student's numbers", () => {
    render(<MentorPairs members={members} pairings={pairings} onChanged={onChanged} />);
    const list = document.querySelector('[data-qa="team-mentors"] ul')!;
    expect(list.textContent).toContain("Will Fades mentors Chris Clipz");
    expect(list.textContent).not.toMatch(/\$|Hidden|\d+ ?(cuts|visits)/i);
  });

  it("ending one re-reads the team", async () => {
    endPairingAction.mockResolvedValue({ ok: true });
    render(<MentorPairs members={members} pairings={pairings} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(endPairingAction).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Ended Will Fades mentoring Chris Clipz", "success"));
    expect(onChanged).toHaveBeenCalled();
  });
});
