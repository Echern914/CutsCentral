import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BUSINESS_TYPES, SELECTABLE_BUSINESS_TYPE_IDS } from "@chairback/config/businessTypes";

/**
 * The business-type picker and editor.
 *
 * The defects worth catching here are RENDER defects: a prompt that blocks a
 * shop that ignores it, a card offered to a seat whose save would 403, and a
 * layout that overflows on a phone. None of those show up in a logic test.
 */
const saveBusinessTypeAction = vi.hoisted(() => vi.fn());
vi.mock("../actions", () => ({ saveBusinessTypeAction }));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { BusinessTypeCard } = await import("./BusinessTypeCard");

beforeEach(() => {
  saveBusinessTypeAction.mockReset();
  saveBusinessTypeAction.mockResolvedValue({ ok: true });
  toast.mockReset();
});

describe("the one-time prompt (a shop that has never been asked)", () => {
  it("leads with the question rather than a settings label", () => {
    render(<BusinessTypeCard current="barber" selected={false} canEdit />);
    expect(screen.getByText("What kind of business is this?")).toBeTruthy();
  });

  it("pre-selects nothing, so the stored default is never mistaken for an answer", () => {
    // The row says "barber" because a migration put it there. Highlighting it
    // would invite a thoughtless Save that records a choice nobody made.
    render(<BusinessTypeCard current="barber" selected={false} canEdit />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("cannot be saved until something is actually picked", () => {
    render(<BusinessTypeCard current="barber" selected={false} canEdit />);
    expect(screen.getByRole("button", { name: /that's my business/i }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("🔴 never blocks - it is a card, not a modal or an interstitial", () => {
    const { container } = render(<BusinessTypeCard current="barber" selected={false} canEdit />);
    // A shop that ignores this keeps booking and texting exactly as before. An
    // overlay or a dialog role would make an unanswered question load-bearing.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".fixed")).toBeNull();
  });

  it("says plainly that nothing of the shop's own is changed", () => {
    render(<BusinessTypeCard current="barber" selected={false} canEdit />);
    expect(
      screen.getByText(/never renamed or altered/i),
    ).toBeTruthy();
  });
});

describe("authorization", () => {
  it("renders nothing for a seat that cannot save it", () => {
    // Offering a button that will 403 is worse than offering nothing.
    const { container } = render(
      <BusinessTypeCard current="barber" selected={false} canEdit={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("the editor (a shop that has chosen)", () => {
  it("shows the settings framing and pre-selects the stored type", () => {
    render(<BusinessTypeCard current="nails" selected canEdit />);
    expect(screen.getByText("Business type")).toBeTruthy();
    const chosen = screen.getByRole("radio", { name: /nail studio/i });
    expect(chosen.getAttribute("aria-checked")).toBe("true");
  });

  it("saves the picked id and reports success", async () => {
    const user = userEvent.setup();
    render(<BusinessTypeCard current="barber" selected canEdit />);
    await user.click(screen.getByRole("radio", { name: /auto detailing/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(saveBusinessTypeAction).toHaveBeenCalledWith("detailing");
    expect(toast).toHaveBeenCalledWith("Business type saved", "success");
  });

  it("surfaces a failure instead of silently claiming success", async () => {
    saveBusinessTypeAction.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(<BusinessTypeCard current="barber" selected canEdit />);
    await user.click(screen.getByRole("radio", { name: /nail studio/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(screen.getByText(/could not save/i)).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Could not save your business type", "error");
  });

  it("tolerates a stored id the registry no longer knows", () => {
    // A retired or forged value must not blank the card or crash it.
    render(<BusinessTypeCard current="dentist" selected canEdit />);
    expect(screen.getByText("Business type")).toBeTruthy();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
  });
});

describe("every selectable type is offered, once", () => {
  it("renders one card per registry entry with its label and tagline", () => {
    render(<BusinessTypeCard current="barber" selected canEdit />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(SELECTABLE_BUSINESS_TYPE_IDS.length);
    for (const id of SELECTABLE_BUSINESS_TYPE_IDS) {
      const t = BUSINESS_TYPES[id];
      const card = screen.getByRole("radio", { name: new RegExp(escapeRe(t.label), "i") });
      expect(within(card).getByText(t.tagline)).toBeTruthy();
    }
  });

  it("is a labelled radiogroup, so it is reachable and announced", () => {
    render(<BusinessTypeCard current="barber" selected canEdit />);
    const group = screen.getByRole("radiogroup", { name: /business type/i });
    expect(group).toBeTruthy();
    // Real buttons, so they are tabbable and Enter/Space activate them without
    // any keyboard handling of our own.
    for (const radio of within(group).getAllByRole("radio")) {
      expect(radio.tagName).toBe("BUTTON");
    }
  });
});

describe("layout", () => {
  it("keeps every option at the touch-target floor and lets text shrink", () => {
    render(<BusinessTypeCard current="barber" selected canEdit />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.className).toContain("min-h-11");
      // 🔴 `min-w-0` on the text column is load-bearing: without it the flex
      // child refuses to shrink and a long tagline pushes the card into a
      // horizontal scroll on a narrow phone. A "zoomed in" render is nearly
      // always this.
      expect(radio.querySelector(".min-w-0")).not.toBeNull();
      expect(radio.className).toContain("min-w-0");
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
