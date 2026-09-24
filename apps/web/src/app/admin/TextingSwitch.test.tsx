import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * THE TEXTING SWITCH on the admin page. It turns every SMS on the platform on
 * or off, so:
 *  - the first press changes NOTHING - it asks, and says what the flip means;
 *  - confirming sends exactly the opposite of what is showing;
 *  - a failed save leaves the switch showing what is really true.
 */

const setTextingAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  setTextingAction: (...a: unknown[]) => setTextingAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { TextingSwitch } = await import("./TextingSwitch");

const on = {
  enabled: true,
  source: "admin" as const,
  updatedAt: "2026-09-23T04:00:00.000Z",
  updatedByEmail: "founder@example.com",
};

beforeEach(() => {
  setTextingAction.mockReset();
  toast.mockReset();
});

describe("the texting switch", () => {
  it("🔴 the first press only asks - nothing is switched", () => {
    render(<TextingSwitch initial={on} />);
    fireEvent.click(document.querySelector('[data-qa="texting-switch"]')!);
    expect(setTextingAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Turn texting OFF for every shop\?/)).toBeTruthy();
    expect(screen.getByText(/AI text receptionist stops answering/)).toBeTruthy();
  });

  it("confirming turns it off, and the page says so", async () => {
    setTextingAction.mockResolvedValue({ ok: true, enabled: false, updatedAt: "2026-09-23T05:00:00.000Z" });
    render(<TextingSwitch initial={on} />);
    fireEvent.click(document.querySelector('[data-qa="texting-switch"]')!);
    fireEvent.click(document.querySelector('[data-qa="texting-apply"]')!);

    await waitFor(() => expect(setTextingAction).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(document.querySelector('[data-qa="texting-status"]')!.textContent).toBe("Texting is OFF"),
    );
    expect(document.querySelector('[data-qa="texting-switch"]')!.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[data-qa="texting-confirm"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith("Texting is off", "success");
  });

  it("turning it back ON warns that texts are billed again", () => {
    render(<TextingSwitch initial={{ ...on, enabled: false }} />);
    fireEvent.click(document.querySelector('[data-qa="texting-switch"]')!);
    expect(screen.getByText(/Turn texting ON for every shop\?/)).toBeTruthy();
    expect(screen.getByText(/billed/)).toBeTruthy();
  });

  it("🔴 a failed save leaves the switch showing what is really true", async () => {
    setTextingAction.mockResolvedValue({ ok: false, error: "failed" });
    render(<TextingSwitch initial={on} />);
    fireEvent.click(document.querySelector('[data-qa="texting-switch"]')!);
    fireEvent.click(document.querySelector('[data-qa="texting-apply"]')!);

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't change texting. Nothing changed.", "error"));
    expect(document.querySelector('[data-qa="texting-status"]')!.textContent).toBe("Texting is ON");
    expect(document.querySelector('[data-qa="texting-switch"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it("says when nobody has set it yet", () => {
    render(<TextingSwitch initial={{ enabled: false, source: "default", updatedAt: null, updatedByEmail: null }} />);
    expect(screen.getByText(/Not set here yet - the server default applies\./)).toBeTruthy();
  });
});
