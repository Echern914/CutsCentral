import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/UpgradeOnWebLink", () => ({
  UpgradeOnWebLink: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="plan-link">{children}</span>
  ),
}));
const api = vi.hoisted(() => ({ main: { ok: false, status: 0, data: null } as Record<string, unknown> }));
vi.mock("@/lib/api", () => ({
  apiGet: async (path: string) =>
    path.startsWith("/api/insights?") ? api.main : { ok: false, status: 500, data: null },
}));
vi.mock("@/lib/me", () => ({ getMe: async () => ({ ok: true, data: { serviceNoun: "cut" } }) }));
vi.mock("@/lib/vocab", () => ({ getVocabulary: async () => ({ stationNoun: "spot" }) }));
vi.mock("@/components/tour/DemoTour", () => ({ DemoTour: () => null }));
vi.mock("./InsightsClient", () => ({ InsightsClient: () => <div data-testid="insights" /> }));
vi.mock("./FeatureAdoptionSection", () => ({ FeatureAdoptionSection: () => null }));

const { InsightsLoadError } = await import("./InsightsLoadError");
const { default: InsightsPage } = await import("./page");

/**
 * The Insights page used to answer every failed load with one line and no
 * way forward, so an owner's screenshot couldn't say what went wrong. Each
 * failure now says what it is, and only the ones a retry can fix offer one.
 */
describe("Insights load error", () => {
  beforeEach(() => refresh.mockReset());

  it.each([
    [0, "Insights took too long to load"],
    [429, "Too many requests at once"],
    [500, "Insights didn't load"],
    [503, "Insights didn't load"],
  ])("status %i says %j and offers Try again", (status, title) => {
    render(<InsightsLoadError status={status} />);
    expect(screen.getByRole("alert")).toHaveTextContent(title);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByTestId("plan-link")).toBeNull();
  });

  it("names the error code on a server error, so a screenshot carries it", () => {
    render(<InsightsLoadError status={502} />);
    expect(screen.getByRole("alert")).toHaveTextContent("error 502");
  });

  it("🔴 a lapsed plan says so and points to the plan, never a retry that can't help", () => {
    render(<InsightsLoadError status={402} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Insights is paused");
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing is lost");
    expect(screen.getByTestId("plan-link")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a seat without Insights is told whose call it is, with nothing to retry", () => {
    render(<InsightsLoadError status={403} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Insights is for owners and managers");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByTestId("plan-link")).toBeNull();
  });

  it("Try again reloads the page's data, and says so if it still doesn't load", () => {
    render(<InsightsLoadError status={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Still not loading/)).toBeInTheDocument();
  });
});

describe("Insights page", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => logged.mockClear());

  it.each([
    [402, "Insights is paused"],
    [403, "Insights is for owners and managers"],
    [0, "Insights took too long to load"],
    [500, "Insights didn't load"],
  ])("🔴 a %i from the API shows its own message, and logs the status", async (status, title) => {
    api.main = { ok: false, status, data: null, error: "boom" };
    render(await InsightsPage());
    expect(screen.getByRole("alert")).toHaveTextContent(title);
    expect(screen.queryByText("Could not load your insights.")).toBeNull();
    expect(logged).toHaveBeenCalledWith("insights: main read failed", { status, error: "boom" });
  });

  it("a good read renders Insights, with no error and nothing logged", async () => {
    api.main = { ok: true, status: 200, data: {} };
    render(await InsightsPage());
    expect(screen.getByTestId("insights")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });
});
