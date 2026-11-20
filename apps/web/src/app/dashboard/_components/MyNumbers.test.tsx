import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { MyNumbersData } from "./barberReportActions";

/**
 * "My numbers" on a team member's home screen: their own appointments,
 * revenue and tips. The scoping is the API's (own chair from the session);
 * what this pins is that the screen asks for a period and nothing else, says
 * nothing for a login with no chair, and never shows a $0 tips figure for a
 * shop that doesn't take tips.
 */
const getMyNumbersAction = vi.hoisted(() => vi.fn());
vi.mock("./barberReportActions", () => ({ getMyNumbersAction }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { MyNumbers } = await import("./MyNumbers");

const mine = (over: Partial<MyNumbersData> = {}): MyNumbersData => ({
  chair: { id: "dee", name: "Dee" },
  reason: null,
  period: "30d",
  periodLabel: "Last 30 days",
  visits: 12,
  noShows: 0,
  revenueCents: 54_000,
  tipsCents: 6_250,
  ...over,
});

beforeEach(() => getMyNumbersAction.mockReset());

describe("My numbers", () => {
  it("🔴 shows their own figures, and asks for a period - never for a person", async () => {
    getMyNumbersAction.mockResolvedValue({ ok: true, data: mine() });
    render(<MyNumbers />);
    const card = await screen.findByTestId("my-numbers");
    expect(card.textContent).toMatch(/12Visits/);
    expect(card.textContent).toMatch(/\$540Revenue/);
    expect(card.textContent).toMatch(/\$62\.50Tips/);
    expect(getMyNumbersAction).toHaveBeenCalledWith("30d");
    expect(getMyNumbersAction.mock.calls[0]).toHaveLength(1);

    getMyNumbersAction.mockResolvedValue({
      ok: true,
      data: mine({ period: "7d", periodLabel: "Last 7 days", visits: 3, noShows: 1, revenueCents: 12_000 }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    });
    expect(getMyNumbersAction).toHaveBeenLastCalledWith("7d");
    await waitFor(() => expect(screen.getByTestId("my-numbers").textContent).toMatch(/3Visits/));
    expect(screen.getByTestId("my-numbers").textContent).toMatch(/including 1 no-show, which earn nothing/);
  });

  it("🔴 no tips figure where the shop has none", async () => {
    getMyNumbersAction.mockResolvedValue({ ok: true, data: mine({ tipsCents: null }) });
    render(<MyNumbers />);
    const card = await screen.findByTestId("my-numbers");
    expect(card.textContent).not.toMatch(/\$\d[\d.,]*Tips/);
  });

  it("a login with no chair linked, or a failed first read, shows nothing here", async () => {
    getMyNumbersAction.mockResolvedValue({ ok: true, data: { chair: null, reason: "no_chair_linked" } });
    const { unmount } = render(<MyNumbers />);
    await waitFor(() => expect(getMyNumbersAction).toHaveBeenCalled());
    expect(screen.queryByTestId("my-numbers")).toBeNull();
    unmount();

    getMyNumbersAction.mockResolvedValue({ ok: false });
    render(<MyNumbers />);
    await waitFor(() => expect(getMyNumbersAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("my-numbers")).toBeNull();
  });

  it("a failed switch keeps the last figures and says so", async () => {
    getMyNumbersAction.mockResolvedValue({ ok: true, data: mine() });
    render(<MyNumbers />);
    await screen.findByTestId("my-numbers");
    getMyNumbersAction.mockResolvedValue({ ok: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("my-numbers").textContent).toMatch(/Couldn't load that period/),
    );
    expect(screen.getByTestId("my-numbers").textContent).toMatch(/12Visits/);
  });
});
