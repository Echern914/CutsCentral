import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RebookPanel } from "./RebookPanel";
import { nudgeClientAction } from "../../actions";

vi.mock("../../actions", () => ({ nudgeClientAction: vi.fn() }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

/**
 * The Nudge button says WHERE the nudge went - their ChairBack app, only the
 * app's bell, or a text - and, when nothing could reach them, why. "Nudge
 * sent" alone left the barber guessing while texting was off.
 */
function nudgeWith(result: Awaited<ReturnType<typeof nudgeClientAction>>) {
  vi.mocked(nudgeClientAction).mockResolvedValueOnce(result);
  toast.mockClear();
  render(<RebookPanel clientId="c1" daysSince={40} serviceLabel="cut" overdue canNudge />);
  fireEvent.click(screen.getByRole("button", { name: "Nudge now" }));
}

describe("RebookPanel nudge", () => {
  it("to their app", async () => {
    nudgeWith({ ok: true, channel: "app" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sent to their ChairBack app", "success"));
  });

  it("only to the app's bell, when their notifications are off", async () => {
    nudgeWith({ ok: true, channel: "app_inbox" });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("In their ChairBack app - their notifications are off", "success"),
    );
  });

  it("nobody reachable: the server's reason, not a vague failure", async () => {
    nudgeWith({
      ok: false,
      error: "unreachable",
      reason: "They don't have the ChairBack app, and texting is turned off.",
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("They don't have the ChairBack app, and texting is turned off.", "error"),
    );
  });
});
