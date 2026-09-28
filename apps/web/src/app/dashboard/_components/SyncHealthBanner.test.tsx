import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncHealthBanner } from "./SyncHealthBanner";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../actions", () => ({ repairAcuitySyncAction: vi.fn() }));

/**
 * The home screen's Acuity banner. When Acuity refuses ChairBack's sign-in,
 * Repair cannot help (it uses that same sign-in), so the banner asks for a
 * reconnect instead, linking straight to Acuity's sign-in.
 */

const HREF = "https://api.test/api/acuity/oauth/start";

describe("SyncHealthBanner", () => {
  it("a refused sign-in asks to Reconnect Acuity, linking to the sign-in, with no Repair", () => {
    render(<SyncHealthBanner needsRepair={false} needsReconnect reconnectHref={HREF} />);
    const link = screen.getByRole("link", { name: "Reconnect Acuity" });
    expect(link.getAttribute("href")).toBe(HREF);
    expect(screen.getByText(/stopped accepting ChairBack's sign-in/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair sync" })).toBeNull();
  });

  it("wins over Repair when both would apply", () => {
    render(<SyncHealthBanner needsRepair needsReconnect reconnectHref={HREF} />);
    expect(screen.getByRole("link", { name: "Reconnect Acuity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair sync" })).toBeNull();
  });

  it("a broken sync with a working sign-in still offers Repair", () => {
    render(<SyncHealthBanner needsRepair reconnectHref={HREF} />);
    expect(screen.getByRole("button", { name: "Repair sync" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Reconnect Acuity" })).toBeNull();
  });

  it("says nothing when all is well", () => {
    const { container } = render(<SyncHealthBanner needsRepair={false} reconnectHref={HREF} />);
    expect(container.textContent).toBe("");
  });
});
