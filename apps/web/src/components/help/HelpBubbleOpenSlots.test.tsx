import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { OpenSlotsBrief } from "@chairback/config/openSlots";

/**
 * Drick asked from the corner bubble on his phone. The bubble asks for the
 * shop's open-slot count ONLY when that question is asked - never on page
 * load - and falls back to the written answer when it cannot get one.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
const getOpenSlots = vi.hoisted(() => vi.fn());
vi.mock("@/app/dashboard/assistant/actions", () => ({ getOpenSlots }));

const { HelpBubble } = await import("./HelpBubble");
const { HelpSeatSync } = await import("./helpSeat");

const BRIEF: OpenSlotsBrief = {
  scope: "own",
  today: "2026-10-18",
  days: [
    { date: "2026-10-18", weekday: 0, open: 0, capacity: 0 },
    { date: "2026-10-19", weekday: 1, open: 3, capacity: 16 },
    { date: "2026-10-20", weekday: 2, open: 0, capacity: 16 },
    { date: "2026-10-21", weekday: 3, open: 0, capacity: 0 },
    { date: "2026-10-22", weekday: 4, open: 0, capacity: 0 },
    { date: "2026-10-23", weekday: 5, open: 0, capacity: 0 },
    { date: "2026-10-24", weekday: 6, open: 0, capacity: 0 },
    { date: "2026-10-25", weekday: 0, open: 0, capacity: 0 },
  ],
  chairs: 1,
  service: "Cut (30 min)",
  bookingUrl: null,
};

async function ask(q: string) {
  fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: q } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  });
}

function mount(seat: boolean) {
  render(
    <>
      {seat && <HelpSeatSync role="BARBER" setup={null} />}
      <HelpBubble />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open the assistant" }));
}

beforeEach(() => getOpenSlots.mockReset());

describe("the corner Assistant, asked how many slots are open", () => {
  it("🔴 counts only when asked, then answers from the count", async () => {
    getOpenSlots.mockResolvedValue(BRIEF);
    mount(true);
    expect(getOpenSlots).not.toHaveBeenCalled();
    await ask("how do I set my hours");
    expect(getOpenSlots).not.toHaveBeenCalled();
    await ask("How many slots do I have open for next week?");
    expect(getOpenSlots).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Next week \(Oct 19-25\) you have 3 open times on your chair: Mon 3, Tue 0 \(full\), Wed closed/)).toBeInTheDocument();
    // A follow-up reuses the count it already has.
    await ask("how many open slots tomorrow");
    expect(getOpenSlots).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Tomorrow \(Mon Oct 19\) you have 3 open times on your chair, of 16/)).toBeInTheDocument();
  });

  it("🔴 a failed count leaves the written answer, never a number", async () => {
    getOpenSlots.mockResolvedValue(null);
    mount(true);
    await ask("How many slots do I have open for next week?");
    expect(await screen.findByText(/Your calendar shows every open time/)).toBeInTheDocument();
    expect(screen.queryByText(/Counting your open times/)).toBeNull();
  });

  it("with no seat (a marketing page), nothing is fetched", async () => {
    mount(false);
    await ask("How many slots do I have open for next week?");
    expect(getOpenSlots).not.toHaveBeenCalled();
    expect(screen.getByText(/Your calendar shows every open time/)).toBeInTheDocument();
  });
});
