import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { Goal, PlannerData } from "./page";

/**
 * Insights saves that failed without a word.
 *
 *  - 🔴 a per-service quota's Save and Remove, and the chair-time target's,
 *    stopped "Saving…" and left the editor open as if nothing had been asked;
 *  - the goal planner's "Couldn't save the plan" sat at the bottom of a long
 *    sheet, out of sight of Save on a phone.
 */

const a = vi.hoisted(() => ({
  clearChairTimeGoalAction: vi.fn(),
  clearGoalAction: vi.fn(),
  goalAction: vi.fn(),
  insightsAction: vi.fn(),
  saveChairTimeGoalAction: vi.fn(),
  saveGoalAction: vi.fn(),
  utilizationAction: vi.fn(),
  yearlyReportOptionsAction: vi.fn(),
  yearlyReportAction: vi.fn(),
}));
vi.mock("./actions", () => a);
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ServiceBars, UtilizationCard } = await import("./InsightsClient");
const { GoalPlanner } = await import("./GoalPlanner");

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.utilizationAction.mockResolvedValue(null);
});

const SERVICES = [{ serviceId: "svc_1", name: "Fade", count: 3, revenue: 120 }] as never;

describe("a service's quota", () => {
  it("🔴 a refused Save says so in the editor, and the editor stays open", async () => {
    a.saveGoalAction.mockResolvedValue({ ok: false });
    const onRefreshGoals = vi.fn(async () => {});
    render(
      <ServiceBars
        services={SERVICES}
        pending={false}
        serviceGoals={[]}
        onRefreshGoals={onRefreshGoals}
        serviceNoun="visit"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ target" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't save that target/);
    expect(onRefreshGoals).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("a thrown Remove says it is still set, and Save comes back", async () => {
    a.clearGoalAction.mockRejectedValue(new Error("network"));
    render(
      <ServiceBars
        services={SERVICES}
        pending={false}
        serviceGoals={[
          { serviceId: "svc_1", name: "Fade", metric: "visits", period: "week", target: 12, actual: 3, pct: 0.25 },
        ]}
        onRefreshGoals={vi.fn(async () => {})}
        serviceNoun="visit"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "3/12 wk" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/It's still set/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the chair-time target", () => {
  it("🔴 a refused Save says so where the editor is", async () => {
    a.saveChairTimeGoalAction.mockResolvedValue({ ok: false });
    render(
      <UtilizationCard
        period={"week" as never}
        bucket={null}
        range={null}
        chairTimeTarget={null}
        onRefreshGoals={vi.fn(async () => {})}
        onSelectPeriod={vi.fn()}
        onApplyRange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set a target" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save your target. Try again.")).toBeTruthy();
  });
});

describe("the goal planner", () => {
  const goal: Goal = { metric: "revenue", period: "week", target: 1000, plan: null, progress: null };
  const planner: PlannerData = {
    services: [
      {
        serviceId: "svc_1",
        name: "Fade",
        price: 40,
        durationMin: 30,
        week: { cuts: 10, revenue: 400 },
        month: { cuts: 40, revenue: 1600 },
      },
    ],
    capacity: { week: { openMin: 2400 }, month: { openMin: 9600 } },
  };

  it("🔴 a failed save is read beside Save, not at the bottom of the sheet", async () => {
    a.saveGoalAction.mockResolvedValue({ ok: false });
    render(<GoalPlanner goal={goal} planner={planner} onSaved={vi.fn()} onClose={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save goal & plan" });
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't save the plan/);
    // Same footer as the button.
    expect(within(alert.parentElement!).getByRole("button", { name: "Save goal & plan" })).toBe(save);
  });

  it("a thrown save gives Save back instead of 'Saving…' forever", async () => {
    a.saveGoalAction.mockRejectedValue(new Error("network"));
    render(<GoalPlanner goal={goal} planner={planner} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save goal & plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't save the plan/);
    expect((screen.getByRole("button", { name: "Save goal & plan" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
