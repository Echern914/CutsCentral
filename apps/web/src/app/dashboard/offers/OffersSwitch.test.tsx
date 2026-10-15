import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * The owner switches Offers & codes on and off from its own page.
 *
 *  - off: the owner gets the switch, anyone else is told who can;
 *  - two taps send one request;
 *  - switching off asks first, and says what it does to codes and bookings;
 *  - a refusal stays on screen.
 */
const setEnabled = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ setOffersEnabledAction: setEnabled }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

const { OffersSwitch } = await import("./OffersSwitch");

beforeEach(() => {
  setEnabled.mockReset();
  refresh.mockReset();
});

describe("Offers & codes switch", () => {
  it("off, for the owner: one tap switches it on, and a second tap sends nothing more", async () => {
    let answer!: (v: { ok: boolean }) => void;
    setEnabled.mockReturnValue(new Promise((r) => (answer = r)));
    render(<OffersSwitch enabled={false} canSwitch />);
    expect(screen.getByTestId("offers-off").textContent).toMatch(/off for your shop/);

    const on = screen.getByRole("button", { name: "Switch on Offers & codes" });
    // Both taps land before React re-renders (and disables the button), as a
    // phone's double tap can: only the busy ref stands between them.
    await act(async () => {
      on.click();
      on.click();
    });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(true);

    await act(async () => answer({ ok: true }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("off, for anyone else: no switch, and they're told who can", () => {
    render(<OffersSwitch enabled={false} canSwitch={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("The shop owner can switch it on here.")).toBeTruthy();
  });

  it("on: switching off asks first, says what it does, and Keep it on changes nothing", async () => {
    setEnabled.mockResolvedValue({ ok: true });
    render(<OffersSwitch enabled canSwitch />);
    fireEvent.click(screen.getByRole("button", { name: "Switch off Offers & codes" }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(screen.getByTestId("offers-switch-confirm").textContent).toMatch(
      /Every code stops working at once.*Bookings already made keep their price/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(screen.queryByTestId("offers-switch-confirm")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Switch off Offers & codes" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch off" }));
    });
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("on, for anyone but the owner: nothing to switch", () => {
    const { container } = render(<OffersSwitch enabled canSwitch={false} />);
    expect(container.textContent).toBe("");
  });

  it("a refusal stays on screen and changes nothing", async () => {
    setEnabled.mockResolvedValue({ ok: false, error: "Only the shop owner can switch this." });
    render(<OffersSwitch enabled={false} canSwitch />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch on Offers & codes" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Only the shop owner can switch this\./);
    expect(refresh).not.toHaveBeenCalled();
  });
});
