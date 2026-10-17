import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * The winner approves exactly what will be posted (Eric, 2026-10-17): the
 * card as it will show - title, what she does, how, why, her stats - and an
 * Approve that sends once. Declining asks first.
 */
// A plain function, not vi.fn(): a vi.fn() holding a pending promise crashes
// the vitest worker whenever any test in the file fails.
const decide = vi.hoisted(() => ({
  calls: [] as string[],
  impl: (_id: string, _d: string): Promise<unknown> => new Promise(() => {}),
}));
vi.mock("./actions", () => ({
  decideAwardAction: (id: string, d: string) => {
    decide.calls.push(`${id}:${d}`);
    return decide.impl(id, d);
  },
}));

const { ApproveAward } = await import("./ApproveAward");

const award = {
  id: "aw1",
  month: "2026-10",
  monthLabel: "October 2026",
  title: "Lash Artist of the Month",
  winnerName: "Jera",
  specialty: "Lash extensions · Brow lamination",
  headline: "Most booked in October",
  description: "Booked solid all month.",
  stats: [{ key: "appointments", label: "Appointments in the last 30 days", value: "112" }],
};

describe("approving the award", () => {
  it("🔴 shows exactly what will be posted - stats and what she does included", () => {
    render(<ApproveAward award={award} />);
    const box = screen.getByText("Lash Artist of the Month").closest("div")!;
    for (const t of ["Jera", "Lash extensions · Brow lamination", "Most booked in October", "Booked solid all month.", "112"]) {
      expect(box.textContent).toContain(t);
    }
    expect(screen.getByText(/Nothing is posted until you approve it/)).toBeTruthy();
  });

  it("🔴 approves once, however fast the taps", async () => {
    decide.calls = [];
    render(<ApproveAward award={award} />);
    const btn = screen.getByRole("button", { name: "Approve and post it" });
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(decide.calls).toEqual(["aw1:approve"]);
  });

  it("declining asks first, then says nothing was posted", async () => {
    decide.calls = [];
    decide.impl = async () => ({ ok: true, status: "DECLINED" });
    render(<ApproveAward award={award} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(decide.calls).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, decline" }));
    });
    expect(decide.calls).toEqual(["aw1:decline"]);
    expect(screen.getByRole("status").textContent).toMatch(/Nothing was posted/);
  });
});
