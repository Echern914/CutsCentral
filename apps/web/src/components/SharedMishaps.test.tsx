import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * Shared-UI mishaps from the 2026-10-08 sweep:
 *
 *  - 🔴 the owner's Assistant bubble showed on client pages (kiosk, waitlist
 *    hold, My rewards) and on a shop's own custom domain;
 *  - a number box that takes negatives opened the iPhone pad with no minus key;
 *  - My rewards had no way back to fix a mistyped number.
 */

const pathname = vi.hoisted(() => ({ current: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
const rec = vi.hoisted(() => ({
  recoveryChallengeAction: vi.fn(),
  recoveryVerifyAction: vi.fn(),
  recoveryShopsAction: vi.fn(),
  recoverySelectAction: vi.fn(),
}));
vi.mock("@/app/my-rewards/actions", () => rec);

const { HelpBubble } = await import("./help/HelpBubble");
const { NumberField } = await import("./ui/NumberField");
const { MyRewardsClient } = await import("@/app/my-rewards/MyRewardsClient");

beforeEach(() => {
  pathname.current = "/dashboard";
  for (const f of Object.values(rec)) f.mockReset();
});

describe("the Assistant bubble", () => {
  it("shows on the dashboard", () => {
    render(<HelpBubble />);
    expect(screen.getByRole("button", { name: "Open the assistant" })).toBeTruthy();
  });

  it.each(["/kiosk", "/line", "/waitlist/hold/abc", "/my-rewards", "/custom-domain/x.com"])(
    "🔴 never shows on the client page %s",
    (path) => {
      pathname.current = path;
      render(<HelpBubble />);
      expect(screen.queryByRole("button", { name: "Open the assistant" })).toBeNull();
    },
  );
});

describe("number boxes", () => {
  it("a box that takes negatives gets a keyboard with a minus key", () => {
    render(<NumberField aria-label="Price change" value={0} onChange={() => {}} min={-50} max={50} />);
    expect(screen.getByLabelText("Price change").getAttribute("inputmode")).toBeNull();
  });

  it("a box that doesn't keeps the digit pad", () => {
    render(<NumberField aria-label="Minutes" value={5} onChange={() => {}} min={0} integer />);
    expect(screen.getByLabelText("Minutes").getAttribute("inputmode")).toBe("numeric");
  });
});

describe("My rewards", () => {
  it("a mistyped number can be changed from the code step", async () => {
    rec.recoveryChallengeAction.mockResolvedValue({ ok: true, status: 200, data: { ok: true }, error: null });
    render(<MyRewardsClient />);
    fireEvent.change(screen.getByPlaceholderText(/555/), { target: { value: "3025550199" } });
    fireEvent.click(screen.getByText(/text me a code/i));
    fireEvent.click(await screen.findByRole("button", { name: "Use a different number" }));
    expect(screen.getByPlaceholderText(/555/)).toBeTruthy();
  });
});
