import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReviewAsk } from "./ReviewAsk";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/contactUri", () => ({ copyText }));

const box = () => screen.getByRole("textbox", { name: "Your message" }) as HTMLTextAreaElement;

/**
 * Reviews can't come across from Booksy or TheCut, so the guide hands the
 * shop a message to send its regulars itself. ChairBack sends nothing.
 */
describe("ReviewAsk", () => {
  beforeEach(() => copyText.mockReset());

  it("writes a message with the shop's review link on its page", () => {
    render(<ReviewAsk appBase="https://getchairback.com/" slug="demo-shop" shopName="Demo Studio" />);
    expect(box().value).toContain("It's Demo Studio.");
    expect(box().value).toContain("https://getchairback.com/s/demo-shop#reviews");
    expect(box().value).toMatch(/would you leave me a quick review\?/);
  });

  it("an unset APP_BASE_URL still gives an absolute link, from the page's own origin", () => {
    render(<ReviewAsk appBase="" slug="demo-shop" shopName="Demo Studio" />);
    expect(box().value).toContain(`${window.location.origin}/s/demo-shop#reviews`);
  });

  it("copies the message, edits included", async () => {
    copyText.mockResolvedValue(true);
    render(<ReviewAsk appBase="https://getchairback.com" slug="demo-shop" shopName="Demo Studio" />);
    fireEvent.change(box(), { target: { value: "Hey! Review me: https://getchairback.com/s/demo-shop#reviews" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    });
    expect(copyText).toHaveBeenCalledWith("Hey! Review me: https://getchairback.com/s/demo-shop#reviews");
    expect(screen.getByRole("button", { name: "Copied ✓" })).toBeTruthy();
  });

  it("🔴 when copying is refused, selects the words so they can be copied by hand", async () => {
    copyText.mockResolvedValue(false);
    render(<ReviewAsk appBase="https://getchairback.com" slug="demo-shop" shopName="Demo Studio" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/Couldn't copy automatically/);
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(0);
    expect(box().selectionEnd).toBe(box().value.length);
  });
});
