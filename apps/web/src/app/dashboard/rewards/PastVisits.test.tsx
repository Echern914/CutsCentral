import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PastVisits } from "./PastVisits";
import { creditPastVisitsAction, previewPastVisitsAction } from "./actions";

vi.mock("./actions", () => ({
  previewPastVisitsAction: vi.fn(),
  creditPastVisitsAction: vi.fn(),
}));

const counts = (visits: number, punches: number, customers: number) => ({
  startedAt: "2026-09-20T12:00:00.000Z",
  from: "2026-06-20T12:00:00.000Z",
  visits,
  punches,
  customers,
});

/**
 * Crediting past visits as the owner meets it: nothing is written by looking,
 * the check says exactly what a credit would give, and only "Credit them"
 * credits - for the period the owner picked.
 */
describe("PastVisits", () => {
  beforeEach(() => {
    vi.mocked(previewPastVisitsAction).mockReset();
    vi.mocked(creditPastVisitsAction).mockReset();
    vi.mocked(previewPastVisitsAction).mockResolvedValue({ ok: true, data: counts(214, 230, 61) });
    vi.mocked(creditPastVisitsAction).mockResolvedValue({ ok: true, data: counts(214, 230, 61) });
  });

  it("checks first and says what it would give; only a confirm credits", async () => {
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await screen.findByText("Credit 214 past visits: 230 punches to 61 customers.");
    expect(previewPastVisitsAction).toHaveBeenCalledWith(3);
    expect(creditPastVisitsAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Credit them" }));
    await screen.findByText("Done. 61 customers got 230 punches.");
    expect(creditPastVisitsAction).toHaveBeenCalledWith(3);
  });

  it("picking another period clears the check, and credits that period", async () => {
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("button", { name: "Credit them" });

    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    expect(screen.queryByRole("button", { name: "Credit them" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    fireEvent.click(await screen.findByRole("button", { name: "Credit them" }));
    await waitFor(() => expect(creditPastVisitsAction).toHaveBeenCalledWith(12));
  });

  it("a slow check for one period is never shown - or confirmable - beside another", async () => {
    let answer!: (v: { ok: true; data: ReturnType<typeof counts> }) => void;
    vi.mocked(previewPastVisitsAction).mockReturnValueOnce(new Promise((r) => (answer = r)));
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" })); // 3 months, still loading
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));

    answer({ ok: true, data: counts(5, 5, 2) });
    await waitFor(() => expect(previewPastVisitsAction).toHaveBeenCalledWith(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Credit 5 past visits/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Credit them" })).toBeNull();
  });

  it("says so when there is nothing to credit, with no button to press", async () => {
    vi.mocked(previewPastVisitsAction).mockResolvedValue({ ok: true, data: counts(0, 0, 0) });
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await screen.findByText("No past visits to credit from that time.");
    expect(screen.queryByRole("button", { name: "Credit them" })).toBeNull();
  });

  it("reads one visit as one", async () => {
    vi.mocked(previewPastVisitsAction).mockResolvedValue({ ok: true, data: counts(1, 1, 1) });
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByText("Credit 1 past visit: 1 punch to 1 customer.");
  });

  it("a failed check says so and offers nothing to confirm", async () => {
    vi.mocked(previewPastVisitsAction).mockResolvedValue({ ok: false });
    render(<PastVisits />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await screen.findByText("Couldn't check your past visits. Try again.");
    expect(screen.queryByRole("button", { name: "Credit them" })).toBeNull();
  });
});
