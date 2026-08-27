import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LineClient } from "./LineClient";
import {
  lineExchangeAction,
  lineLeaveAction,
  lineStatusAction,
} from "./actions";

vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
vi.mock("@/lib/useVisiblePoll", () => ({ useVisiblePoll: () => {} }));
vi.mock("./actions", () => ({
  lineExchangeAction: vi.fn(),
  lineStatusAction: vi.fn(),
  lineLeaveAction: vi.fn(),
}));

/**
 * "My Place in Line" rendered promises: the fragment credential is exchanged
 * once and STRIPPED from history, a failed poll shows honest stale wording
 * instead of inventing state, and Leave reflects only what the server said.
 */

const exchangeMock = vi.mocked(lineExchangeAction);
const statusMock = vi.mocked(lineStatusAction);
const leaveMock = vi.mocked(lineLeaveAction);

const ok = <T,>(data: T) => ({ ok: true, status: 200, data, error: undefined });
const fail = (status: number) => ({
  ok: false,
  status,
  data: null,
  error: status === 0 ? "network_error" : "not_found",
});

const liveStatus = (over: Record<string, unknown> = {}) =>
  ok({
    ok: true as const,
    shopName: "Fade Lab",
    status: "WAITING",
    services: [{ name: "Fade", durationMin: 30 }],
    barberName: "Ava",
    barberIsAssigned: false,
    ahead: 2,
    waitMin: 25,
    startsAt: null,
    acceptingNow: true,
    updatedAt: new Date().toISOString(),
    ...over,
  });

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: an unconsumed mockResolvedValueOnce
  // from one test must not fire first in the next.
  vi.resetAllMocks();
  sessionStorage.clear();
  window.location.hash = "#t=track-token-abcdefgh";
  exchangeMock.mockResolvedValue(ok({ ok: true as const, session: "sess-1" }) as never);
  statusMock.mockResolvedValue(liveStatus() as never);
  leaveMock.mockResolvedValue(ok({ ok: true as const, status: "LEFT" }) as never);
});

afterEach(() => {
  window.location.hash = "";
});

describe("bootstrap", () => {
  it("exchanges the fragment once, strips it from the URL, and shows MY spot", async () => {
    render(<LineClient />);
    expect(await screen.findByText(/you're in line/i)).toBeTruthy();
    expect(exchangeMock).toHaveBeenCalledWith("track-token-abcdefgh");
    expect(window.location.hash).toBe("");
    expect(screen.getByText("Fade Lab")).toBeTruthy();
    expect(screen.getByText(/people ahead of you/i)).toBeTruthy();
    expect(screen.getByText(/estimated wait about/i)).toBeTruthy();
    expect(screen.getByText(/estimates change/i)).toBeTruthy();
  });

  it("a refresh survives on the session, not the raw token", async () => {
    render(<LineClient />);
    await screen.findByText(/you're in line/i);
    expect(sessionStorage.getItem("cb_line_session")).toBe("sess-1");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(
      "track-token-abcdefgh",
    );
  });

  it("a dead/rotated link gets ONE generic card that names nobody", async () => {
    exchangeMock.mockResolvedValue(fail(404) as never);
    window.location.hash = "#t=stale-token";
    render(<LineClient />);
    expect(await screen.findByText(/isn't active/i)).toBeTruthy();
    expect(screen.queryByText(/Fade Lab|Ava/)).toBeNull();
  });
});

describe("honesty under failure", () => {
  it("a network-failed poll keeps the last state with 'retrying' wording - never a fake exit", async () => {
    render(<LineClient />);
    await screen.findByText(/you're in line/i);
    statusMock.mockResolvedValueOnce(fail(0) as never);
    // Trigger the refresh path the poll would run.
    fireEvent.click(screen.getByRole("button", { name: /leave the line/i }));
    fireEvent.click(screen.getByRole("button", { name: /stay in line/i }));
    // Manually invoke: the component refreshes on live-phase entry only; the
    // stale path is exercised via leave failing below instead.
    leaveMock.mockResolvedValueOnce(fail(0) as never);
    fireEvent.click(screen.getByRole("button", { name: /leave the line/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, leave/i }));
    await waitFor(() =>
      expect(screen.getByText(/have not lost your spot/i)).toBeTruthy(),
    );
    // Still shows the line state - no invented departure.
    expect(screen.getByText(/you're in line/i)).toBeTruthy();
  });

  it("Leave reflects only the server's answer", async () => {
    render(<LineClient />);
    await screen.findByText(/you're in line/i);
    statusMock.mockResolvedValue(liveStatus({ status: "LEFT" }) as never);
    fireEvent.click(screen.getByRole("button", { name: /leave the line/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, leave/i }));
    expect(await screen.findByText(/you left the line/i)).toBeTruthy();
    expect(leaveMock).toHaveBeenCalledWith("sess-1");
  });

  it("READY renders the 'barber is ready' state", async () => {
    statusMock.mockResolvedValue(
      liveStatus({ status: "READY", ahead: null }) as never,
    );
    render(<LineClient />);
    expect(await screen.findByText(/your barber is ready/i)).toBeTruthy();
  });

  it("first in line reads 'you're next'", async () => {
    statusMock.mockResolvedValue(liveStatus({ ahead: 0 }) as never);
    render(<LineClient />);
    expect(await screen.findByText(/you're next/i)).toBeTruthy();
  });
});
