import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const save = vi.hoisted(() =>
  vi.fn(async (_input: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
);
const refresh = vi.hoisted(() => vi.fn());
vi.mock("../site/actions", () => ({ savePageAction: save }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { HiddenPageBanner } = await import("./HiddenPageBanner");

/**
 * A hidden page stops online booking, and nothing on the dashboard said so: an
 * owner found out from a client's screenshot. The home page now says so, and
 * turns it back on in one tap.
 */
beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  refresh.mockReset();
});

const banner = () => screen.queryByRole("region", { name: "Your page is hidden" });
const turnOn = () => screen.getByRole("button", { name: "Turn it back on" });

describe("the hidden-page banner", () => {
  it("says booking is off, and links to the page settings", () => {
    render(<HiddenPageBanner booksHere />);
    expect(banner()).toHaveTextContent("Clients can't book online");
    expect(screen.getByRole("link", { name: "Page settings" })).toHaveAttribute("href", "/dashboard/site");
  });

  it("for a shop that books elsewhere, says nothing about booking", () => {
    render(<HiddenPageBanner booksHere={false} />);
    expect(banner()).not.toHaveTextContent(/book/i);
  });

  it("🔴 'Turn it back on' saves the page live, refreshes, and goes away", async () => {
    render(<HiddenPageBanner booksHere />);
    fireEvent.click(turnOn());
    await waitFor(() => expect(banner()).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ publicPageEnabled: true });
    expect(refresh).toHaveBeenCalled();
  });

  it("🔴 a failure stays put and says why", async () => {
    save.mockResolvedValue({ ok: false });
    render(<HiddenPageBanner booksHere />);
    fireEvent.click(turnOn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't turn it on/);
    expect(banner()).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a dropped connection (the action rejects) says so", async () => {
    save.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<HiddenPageBanner booksHere />);
    fireEvent.click(turnOn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't turn it on/);
    expect(banner()).not.toBeNull();
  });

  it("🔴 a double tap saves once", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    save.mockImplementation(() => new Promise((r) => (finish = r)));
    render(<HiddenPageBanner booksHere />);
    fireEvent.click(turnOn());
    fireEvent.click(screen.getByRole("button", { name: /Turn/ }));
    finish({ ok: true });
    await waitFor(() => expect(banner()).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
  });
});
