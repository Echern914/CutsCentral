import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { default: AppError } = await import("./error");
const { default: GlobalError } = await import("./global-error");
const { default: DashboardError } = await import("./dashboard/error");

/**
 * 🔴 NEVER A BLANK PAGE. A barber in the iPhone app hit a white screen they
 * could only escape by force-quitting. Every error boundary must leave a way
 * out that actually works.
 */
const reload = vi.fn();
Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
const err = Object.assign(new Error("boom"), { digest: "d1" });

afterEach(() => {
  cleanup();
  reload.mockClear();
  refresh.mockClear();
  vi.restoreAllMocks();
});

describe("error screens", () => {
  it("an error in a layout shows a Reload that reloads the page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={err} reset={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("an error in the root layout still shows a readable Reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GlobalError error={err} reset={() => {}} />);
    expect(screen.getByText("This page didn't load")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the dashboard's Try again fetches again (refresh) before resetting - reset alone re-shows the same failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    render(<DashboardError error={err} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
