import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The manual reply box. Sending goes out as a text from the shop's number and
 * takes the thread over from the AI, so:
 *
 *  - 🔴 Return on a phone makes a new line. It used to send the half-written
 *    message, which can't be recalled;
 *  - texting switched off says so, instead of "Try again" forever.
 */

const sendReplyAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ sendReplyAction }));

const { ReplyBox } = await import("./ReplyBox");

function pointer(fine: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: fine && q.includes("pointer: fine"), media: q, addEventListener() {}, removeEventListener() {} }),
  });
}

beforeEach(() => {
  sendReplyAction.mockReset();
  sendReplyAction.mockResolvedValue({ ok: true });
});
afterEach(() => {
  // @ts-expect-error - restore jsdom's absence of matchMedia
  delete window.matchMedia;
});

describe("ReplyBox", () => {
  it("🔴 Return on a phone keyboard does not send", () => {
    pointer(false);
    render(<ReplyBox conversationId="c1" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "On my way, be there in" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sendReplyAction).not.toHaveBeenCalled();
  });

  it("Enter at a desk sends", async () => {
    pointer(true);
    render(<ReplyBox conversationId="c1" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "See you at 3" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sendReplyAction).toHaveBeenCalledWith("c1", "See you at 3"));
  });

  it("🔴 texting switched off says so, not 'Try again'", async () => {
    pointer(false);
    sendReplyAction.mockResolvedValue({ ok: false, error: "texting_off" });
    render(<ReplyBox conversationId="c1" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Texting is turned off right now/)).toBeTruthy();
    expect(screen.queryByText(/Try again/)).toBeNull();
  });
});
