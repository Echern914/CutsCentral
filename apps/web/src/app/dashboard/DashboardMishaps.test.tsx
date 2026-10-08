import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * Home, Clients and Team mishaps from the 2026-10-08 sweep - each compiled and
 * looked fine on a desktop, and told the barber something untrue:
 *
 *  - Today counted a lunch block as "1 appointment left" and drew it as a client;
 *  - At risk "Nudge now" went back to "Nudge now" with no reason on a refusal;
 *  - "Preview today's nudges" silently reset when the preview failed;
 *  - Send invite threw after a successful invite and kept the form filled;
 *  - Edit profile's Cancel kept the abandoned edits for the next Save;
 *  - setting a visit's date to today was refused as "in the future" before noon;
 *  - Merge said "No matching clients." before anything had been searched.
 */

const a = vi.hoisted(() => ({
  nudgeNowAction: vi.fn(),
  sweepPreviewAction: vi.fn(),
  runSweepAction: vi.fn(),
  editVisitAction: vi.fn(),
  deleteVisitAction: vi.fn(),
  searchClientsAction: vi.fn(),
  mergeClientAction: vi.fn(),
  updateClientAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { TodayAgenda } = await import("./_components/TodayAgenda");
const { AtRiskTable } = await import("./_components/AtRiskTable");
const { SweepControl } = await import("./_components/SweepControl");
const { VisitHistory } = await import("./clients/[id]/VisitHistory");
const { MergeClient } = await import("./clients/[id]/MergeClient");

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  toast.mockReset();
});

describe("Today", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "r",
      source: "appointment",
      start: "2026-10-08T16:00:00.000Z",
      end: "2026-10-08T16:30:00.000Z",
      clientName: "Marcus Reed",
      serviceName: "Cut",
      serviceColor: null,
      price: 27.5,
      status: "upcoming",
      ...over,
    }) as never;

  it("🔴 a block is not an appointment, and is drawn as one", () => {
    render(
      <TodayAgenda
        rows={[row({ id: "b1", source: "block", clientName: "Lunch", status: "blocked", price: null })]}
        timezone="America/New_York"
      />,
    );
    expect(screen.getByText("Nothing on the books.")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByText(/appointment left/)).toBeNull();
  });

  it("prices keep their cents", () => {
    render(<TodayAgenda rows={[row({})]} timezone="America/New_York" />);
    expect(screen.getByText("$27.50")).toBeTruthy();
    expect(screen.getByText("1 appointment left today.")).toBeTruthy();
  });
});

describe("At risk", () => {
  it("🔴 a refused Nudge now says why", async () => {
    a.nudgeNowAction.mockResolvedValue({ ok: false, reason: "They were nudged 3 days ago - wait 4 more." });
    render(
      <AtRiskTable
        appBaseUrl="https://x.test"
        rows={[
          {
            id: "c1",
            name: "Ana",
            phone: null,
            lastService: null,
            magicToken: "t",
            daysOverdue: 5,
            medianIntervalDays: 21,
            lastVisitAt: "2026-09-01T00:00:00.000Z",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nudge now" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/nudged 3 days ago/);
  });
});

describe("nudge preview", () => {
  it("🔴 a failed preview says so instead of quietly resetting", async () => {
    a.sweepPreviewAction.mockResolvedValue(null);
    render(<SweepControl atRiskCount={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview today's nudges" }));
    expect(await screen.findByText(/Couldn't run the preview/)).toBeTruthy();
  });
});

describe("visit history", () => {
  it("🔴 moving a visit to today never sends a future time", async () => {
    a.editVisitAction.mockResolvedValue({ ok: true });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    yesterday.setHours(23, 30, 0, 0);
    render(
      <VisitHistory
        clientId="c1"
        visits={[{ id: "v1", date: yesterday.toISOString(), status: "COMPLETED", service: "Cut" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const dateBox = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateBox, { target: { value: key } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.editVisitAction).toHaveBeenCalledTimes(1));
    const when = (a.editVisitAction.mock.calls[0]![2] as { when: string }).when;
    expect(Date.parse(when)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("merge search", () => {
  it("says nothing matched only after a search for that text", async () => {
    a.searchClientsAction.mockResolvedValue([]);
    render(<MergeClient clientId="c1" clientName="Ana" />);
    fireEvent.click(screen.getByRole("button", { name: /Merge a duplicate into this client/ }));
    const box = screen.getByPlaceholderText(/Search the duplicate/);
    fireEvent.change(box, { target: { value: "Ma" } });
    expect(screen.queryByText("No matching clients.")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(a.searchClientsAction).toHaveBeenCalled());
    expect(await screen.findByText("No matching clients.")).toBeTruthy();
  });
});

// Keep `within` for readers extending these with scoped queries.
void within;
