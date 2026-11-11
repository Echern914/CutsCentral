import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const save = vi.hoisted(() =>
  vi.fn(async (_input: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
);
vi.mock("./actions", () => ({ savePageAction: save }));

const { PageLiveSwitch, hiddenConsequence } = await import("./PageLiveSwitch");

/**
 * The page's Live switch saves the moment it is flipped.
 *
 * It used to be a pill beside Copy and Open that only changed the form, so a
 * page could be flipped Hidden and stay that way until "Save page" at the
 * bottom of a long editor. Hiding also stops online booking, so it asks first.
 */
const liveSwitch = () => screen.getByRole("switch");

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
});

describe("the page's Live switch", () => {
  it("is a real switch that says what it means", () => {
    render(<PageLiveSwitch initialEnabled booksHere />);
    expect(liveSwitch()).toHaveAttribute("aria-checked", "true");
    expect(liveSwitch()).toHaveAccessibleName("Your page is live");
    expect(screen.getByText("Clients can open your link and book online.")).toBeInTheDocument();
  });

  it("🔴 turning it off asks first, and saves nothing until 'Hide page'", async () => {
    render(<PageLiveSwitch initialEnabled booksHere />);
    fireEvent.click(liveSwitch());
    const dialog = screen.getByRole("alertdialog", { name: "Hide your page?" });
    expect(dialog).toHaveTextContent(hiddenConsequence(true));
    expect(dialog).toHaveTextContent("Online booking stops too.");
    expect(save).not.toHaveBeenCalled();
    expect(liveSwitch()).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "Hide page" }));
    await waitFor(() => expect(liveSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ publicPageEnabled: false });
    expect(liveSwitch()).toHaveAccessibleName("Your page is hidden");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("'Keep it live' closes the question and saves nothing", () => {
    render(<PageLiveSwitch initialEnabled booksHere />);
    fireEvent.click(liveSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Keep it live" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(liveSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("🔴 turning it on saves at once - no question, no Save page", async () => {
    render(<PageLiveSwitch initialEnabled={false} booksHere />);
    expect(screen.getByText(/Hidden, so online booking is off/)).toBeInTheDocument();
    fireEvent.click(liveSwitch());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(liveSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(save).toHaveBeenCalledWith({ publicPageEnabled: true });
  });

  it("🔴 a failed save leaves the switch where it was and says why", async () => {
    save.mockResolvedValue({ ok: false, error: "Something went wrong." });
    render(<PageLiveSwitch initialEnabled={false} booksHere />);
    fireEvent.click(liveSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(liveSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("a failure with no message still says something", async () => {
    save.mockResolvedValue({ ok: false });
    render(<PageLiveSwitch initialEnabled={false} booksHere />);
    fireEvent.click(liveSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save/);
  });

  it("🔴 a dropped connection (the action rejects) says so, and the switch works again after", async () => {
    save.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<PageLiveSwitch initialEnabled={false} booksHere />);
    fireEvent.click(liveSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save/);
    expect(liveSwitch()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(liveSwitch());
    await waitFor(() => expect(liveSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("🔴 a double tap saves once", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    save.mockImplementation(() => new Promise((r) => (finish = r)));
    render(<PageLiveSwitch initialEnabled={false} booksHere />);
    fireEvent.click(liveSwitch());
    fireEvent.click(liveSwitch());
    finish({ ok: true });
    await waitFor(() => expect(liveSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("for a shop that books elsewhere, never promises or warns about online booking", () => {
    render(<PageLiveSwitch initialEnabled booksHere={false} />);
    expect(screen.getByText("Clients can open your link.")).toBeInTheDocument();
    fireEvent.click(liveSwitch());
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent(/booking/i);
  });
});
