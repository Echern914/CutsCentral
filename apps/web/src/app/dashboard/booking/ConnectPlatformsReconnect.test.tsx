import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectPlatforms } from "./ConnectPlatforms";
import type { ConnectStatus } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./actions", () => ({
  disconnectAcuityAction: vi.fn(),
  disconnectSquareAction: vi.fn(),
}));

/**
 * An Acuity connection whose sign-in Acuity now refuses must not read
 * "Connected" on the settings card: it says it is not syncing, and the one
 * obvious button is Reconnect Acuity.
 */

const connect = (over: Partial<ConnectStatus> = {}): ConnectStatus => ({
  acuityConnected: true,
  acuityNeedsReconnect: false,
  acuityAvailable: true,
  squareConnected: false,
  squareAvailable: false,
  ...over,
});

const renderCard = (c: ConnectStatus) =>
  render(<ConnectPlatforms mode="acuity" onPick={() => {}} connect={c} apiBase="https://api.test" />);

describe("the Acuity card", () => {
  it("a working connection reads Connected, with a plain Reconnect", () => {
    renderCard(connect());
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByText("Not syncing")).toBeNull();
    expect(screen.getByText(/Your account stays connected/)).toBeTruthy();
  });

  it("a refused sign-in reads Not syncing and asks to Reconnect Acuity - never Connected", () => {
    renderCard(connect({ acuityNeedsReconnect: true }));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Not syncing")).toBeTruthy();
    expect(screen.getByText(/stopped accepting ChairBack's sign-in/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect Acuity" })).toBeTruthy();
    // Disconnect is still there: the connection and its data are kept.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // And it no longer promises that appointments keep syncing.
    expect(screen.queryByText(/Your account stays connected/)).toBeNull();
  });
});
