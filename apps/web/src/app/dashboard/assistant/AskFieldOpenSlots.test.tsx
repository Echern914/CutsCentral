import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OpenSlotsBrief } from "@chairback/config/openSlots";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { AskField } = await import("./AskField");

/**
 * Drick's question (2026-10-18): "How many slots do I have open for next
 * week?" With the shop's count loaded, the Assistant answers it day by day;
 * without it, the written pointer to the calendar - never a made-up number.
 */
const BRIEF: OpenSlotsBrief = {
  scope: "shop",
  today: "2026-10-18",
  days: [
    { date: "2026-10-18", weekday: 0, open: 0, capacity: 0 },
    { date: "2026-10-19", weekday: 1, open: 4, capacity: 16 },
    { date: "2026-10-20", weekday: 2, open: 6, capacity: 16 },
    { date: "2026-10-21", weekday: 3, open: 5, capacity: 16 },
    { date: "2026-10-22", weekday: 4, open: 8, capacity: 16 },
    { date: "2026-10-23", weekday: 5, open: 0, capacity: 16 },
    { date: "2026-10-24", weekday: 6, open: 0, capacity: 16 },
    { date: "2026-10-25", weekday: 0, open: 0, capacity: 0 },
  ],
  chairs: 2,
  service: "Cut (30 min)",
  bookingUrl: "https://getchairback.com/book/drick",
};

function ask(openSlots: OpenSlotsBrief | null, question = "How many slots do I have open for next week?") {
  render(<AskField role="OWNER" rewardsEnabled affiliateProgramEnabled={false} openSlots={openSlots} />);
  fireEvent.change(screen.getByLabelText("What do you want to do?"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

describe("How many slots do I have open next week?", () => {
  it("is offered as an example under the field", () => {
    render(<AskField role="OWNER" rewardsEnabled affiliateProgramEnabled={false} openSlots={BRIEF} />);
    expect(screen.getByRole("button", { name: "How many slots do I have open next week?" })).toBeInTheDocument();
  });

  it("🔴 answers with the shop's own count, day by day", () => {
    ask(BRIEF);
    expect(screen.getByText(/Next week \(Oct 19-25\) you have 23 open times across 2 chairs: Mon 4, Tue 6/)).toBeInTheDocument();
    expect(screen.getByText(/Busiest: Fri and Sat \(full\)/)).toBeInTheDocument();
    expect(screen.getByText(/counted once per chair - not once per service/)).toBeInTheDocument();
    expect(screen.getByText("Your booking page: https://getchairback.com/book/drick")).toBeInTheDocument();
    expect(screen.queryByText(/I don.t have that one written up exactly/)).toBeNull();
  });

  it("🔴 without the count: where to see them, and no number", () => {
    ask(null);
    expect(screen.getByText(/Your calendar shows every open time/)).toBeInTheDocument();
    expect(screen.queryByText(/open times across/)).toBeNull();
    expect(screen.getByRole("button", { name: /Open appointments/ })).toBeInTheDocument();
  });
});
