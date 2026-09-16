import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RewardsSwitch } from "./RewardsSwitch";
import { setRewardsEnabledAction } from "./actions";

vi.mock("./actions", () => ({ setRewardsEnabledAction: vi.fn(async () => ({ ok: true })) }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * The rewards switch as an owner uses it: it says what OFF means before it
 * happens, turning off asks first (and "no" changes nothing), turning on does
 * not ask, and a failed save snaps back instead of showing a state that isn't.
 */
describe("RewardsSwitch", () => {
  beforeEach(() => {
    vi.mocked(setRewardsEnabledAction).mockReset();
    vi.mocked(setRewardsEnabledAction).mockResolvedValue({ ok: true });
    refresh.mockReset();
    toast.mockReset();
  });

  it("is a real switch that follows the server's value, and says what off means", () => {
    const { rerender } = render(<RewardsSwitch on />);
    const sw = screen.getByRole("switch", { name: /punch cards and rewards/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");

    rerender(<RewardsSwitch on={false} />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/no punch cards, rewards, tiers or loyalty messages/i)).toBeTruthy();
  });

  it("turning off asks first, and a no changes nothing", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RewardsSwitch on />);
    fireEvent.click(screen.getByRole("switch"));

    expect(confirm).toHaveBeenCalledOnce();
    expect(setRewardsEnabledAction).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    confirm.mockRestore();
  });

  it("a confirmed off saves false and refreshes the page", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<RewardsSwitch on />);
    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(setRewardsEnabledAction).toHaveBeenCalledWith(false));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it("turning on doesn't ask", async () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<RewardsSwitch on={false} />);
    fireEvent.click(screen.getByRole("switch"));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(setRewardsEnabledAction).toHaveBeenCalledWith(true));
    confirm.mockRestore();
  });

  it("a failed save says so and snaps back", async () => {
    vi.mocked(setRewardsEnabledAction).mockResolvedValue({ ok: false });
    render(<RewardsSwitch on={false} />);
    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/couldn't/i), "error"),
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(refresh).not.toHaveBeenCalled();
  });
});
