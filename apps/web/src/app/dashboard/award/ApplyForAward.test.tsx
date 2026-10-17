import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AwardMe } from "./actions";

/**
 * Applying for Provider of the Month: the stats are the shop's own (chosen,
 * not typed), it sends once however fast the taps, and a decided month says
 * so instead of offering a form.
 */
// A plain function, not vi.fn(): a vi.fn() holding a pending promise crashes
// the vitest worker whenever any test in the file fails.
const send = vi.hoisted(() => ({
  calls: [] as { pitch: string; statKeys: string[] }[],
  impl: (_i: unknown): Promise<unknown> => new Promise(() => {}),
}));
vi.mock("./actions", () => ({
  applyForAwardAction: (i: { pitch: string; credentials: string; statKeys: string[] }) => {
    send.calls.push({ pitch: i.pitch, statKeys: i.statKeys });
    return send.impl(i);
  },
}));

const { ApplyForAward } = await import("./ApplyForAward");

const me = (over: Partial<AwardMe> = {}): AwardMe => ({
  month: "2026-10",
  monthLabel: "October 2026",
  stats: [
    { key: "appointments", label: "Appointments in the last 30 days", value: "112" },
    { key: "clients", label: "Clients served in the last 30 days", value: "80" },
  ],
  application: null,
  won: [],
  ...over,
});

describe("applying for Provider of the Month", () => {
  it("🔴 sends the stats they chose and the pitch - once, however fast the taps", async () => {
    send.calls = [];
    render(<ApplyForAward me={me()} />);
    fireEvent.click(screen.getByLabelText(/Clients served/));
    fireEvent.change(screen.getByLabelText(/Why you/), { target: { value: "Booked solid all month." } });
    const btn = screen.getByRole("button", { name: "Send my application" });
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(send.calls).toEqual([{ pitch: "Booked solid all month.", statKeys: ["appointments"] }]);
  });

  it("says when it's sent, and offers to update it", async () => {
    send.impl = async () => ({
      ok: true,
      application: { pitch: "Hi", credentials: null, stats: [], status: "SUBMITTED", updatedAt: "2026-10-17T00:00:00Z" },
    });
    render(<ApplyForAward me={me()} />);
    fireEvent.change(screen.getByLabelText(/Why you/), { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send my application" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/Sent/);
    expect(screen.getByRole("button", { name: "Update my application" })).toBeTruthy();
  });

  it("a month already decided shows the result, not a form", () => {
    render(
      <ApplyForAward
        me={me({ application: { pitch: "x", credentials: null, stats: [], status: "WON", updatedAt: "2026-10-17T00:00:00Z" } })}
      />,
    );
    expect(screen.getByText(/You won October 2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /application/ })).toBeNull();
  });
});
