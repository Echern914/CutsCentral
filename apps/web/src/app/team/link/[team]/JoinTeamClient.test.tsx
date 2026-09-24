import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Asking to join a team from its link. "Request sent" appears only once the
 * server has it; a failure keeps the page and the button, so trying again is
 * one tap.
 */

const askToJoinAction = vi.fn();
const refresh = vi.fn();

vi.mock("./actions", () => ({
  askToJoinAction: (...a: unknown[]) => askToJoinAction(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { JoinTeamClient } = await import("./JoinTeamClient");

const view = () =>
  render(<JoinTeamClient team="united-barbershop" teamName="United Barbershop" businessName="Joe's Cuts" />);
const button = () => document.querySelector<HTMLButtonElement>('[data-qa="ask-to-join"]')!;

beforeEach(() => {
  askToJoinAction.mockReset();
  refresh.mockReset();
});

describe("asking to join", () => {
  it("says what joining does, in plain words", () => {
    view();
    expect(screen.getByText("Join United Barbershop's team")).toBeTruthy();
    expect(screen.getByText(/Your clients, bookings and payments stay yours/)).toBeTruthy();
    expect(screen.getByText(/sees nothing until you choose what to share/)).toBeTruthy();
  });

  it("🔴 'Request sent' only after the server has it", async () => {
    let resolve!: (v: unknown) => void;
    askToJoinAction.mockReturnValue(new Promise((r) => (resolve = r)));
    view();
    fireEvent.click(button());
    expect(askToJoinAction).toHaveBeenCalledWith("united-barbershop");
    expect(button().textContent).toBe("Sending…");
    expect(screen.queryByText("Request sent")).toBeNull();

    resolve({ ok: true });
    await waitFor(() => expect(screen.getByText("Request sent")).toBeTruthy());
  });

  it("🔴 a failure keeps the page, says so, and can be retried", async () => {
    askToJoinAction.mockResolvedValueOnce({ ok: false, error: "network_error" });
    view();
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByText("That didn't go through. Try again.")).toBeTruthy());
    expect(button().disabled).toBe(false);

    askToJoinAction.mockResolvedValueOnce({ ok: true });
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByText("Request sent")).toBeTruthy());
  });

  it("already asked elsewhere: the page re-reads and shows where things stand", async () => {
    askToJoinAction.mockResolvedValue({ ok: false, error: "already_linked" });
    view();
    fireEvent.click(button());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
