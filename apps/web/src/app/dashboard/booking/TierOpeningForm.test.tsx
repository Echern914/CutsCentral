import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";

/**
 * "Offer to a tier" reads three things when it opens: what is already held,
 * the day's open times, and who would be told. A failed read used to show as
 * an answer - no "Held now" (so a second hold looked safe), "No open times
 * that day.", "Counting members…" for good. Each now says it couldn't load.
 */

const a = vi.hoisted(() => ({
  createTierOpeningAction: vi.fn(),
  getDashSlotsAction: vi.fn(),
  listTierOpeningsAction: vi.fn(),
  previewTierOpeningAction: vi.fn(),
  releaseTierOpeningAction: vi.fn(),
}));
vi.mock("./actions", () => a);
const reload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reloadPage", () => ({ reloadPage: reload }));

const { TierOpeningForm } = await import("./TierOpeningForm");

const staff = [{ id: "st1", name: "Dee", active: true }] as StaffRow[];
const services = [
  { id: "svc1", name: "Fade", durationMin: 30, price: 40, active: true },
] as ServiceRow[];

function renderForm() {
  render(
    <TierOpeningForm
      staff={staff}
      services={services}
      timezone="America/New_York"
      dayKey="2099-01-06"
      todayKey="2099-01-06"
      onClose={vi.fn()}
      onHeld={vi.fn()}
      toast={vi.fn()}
    />,
  );
}

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.listTierOpeningsAction.mockResolvedValue({ ok: true, openings: [] });
  a.getDashSlotsAction.mockResolvedValue({
    ok: true,
    slots: [{ startsAt: "2099-01-06T15:00:00.000Z", endsAt: "2099-01-06T15:30:00.000Z" }],
  });
  a.previewTierOpeningAction.mockResolvedValue({ ok: true, members: 5, inApp: 3 });
  reload.mockReset();
});

describe("Offer to a tier, when a read fails", () => {
  it("reads all three and shows them when they answer", async () => {
    renderForm();
    expect(await screen.findByText(/3 of 5 members have the app/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("🔴 failed open times are not 'No open times that day.', and Try again reads again", async () => {
    a.getDashSlotsAction.mockResolvedValueOnce({ ok: false });
    renderForm();
    expect(await screen.findByText(/Couldn.t load open times\./)).toBeTruthy();
    expect(screen.queryByText("No open times that day.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "10:00 AM" })).toBeTruthy();
  });

  it("🔴 a failed member count says so instead of 'Counting members…' for good", async () => {
    a.previewTierOpeningAction.mockRejectedValueOnce(new TypeError("Load failed"));
    renderForm();
    expect(await screen.findByText(/Couldn.t load who would be told\./)).toBeTruthy();
    expect(screen.queryByText("Counting members…")).toBeNull();
  });

  it("🔴 failed holds say so, rather than looking like nothing is held", async () => {
    a.listTierOpeningsAction.mockResolvedValueOnce({ ok: false });
    renderForm();
    expect(await screen.findByText(/Couldn.t load what you.re holding now\./)).toBeTruthy();
  });

  it("a form left open across a deploy offers Reload", async () => {
    // Next 14.2 resolves a call to a server action the new build lacks with
    // undefined (lib/loadAction.ts).
    a.getDashSlotsAction.mockResolvedValueOnce(undefined);
    renderForm();
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
