import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./actions", () => ({ saveBookingPolicyAction: vi.fn() }));

const { BookingPolicyCard } = await import("./BookingPolicyCard");
const actions = await import("./actions");
const save = vi.mocked(actions.saveBookingPolicyAction);

/**
 * "Your policies" in booking settings: the owner writes the policy and the
 * lines customers must tick. This pins that what is typed is what is saved -
 * trimmed, blank lines dropped - that the outcome is said on the card, and
 * that the eight-line limit is visible rather than a surprise refusal.
 */

const toast = vi.fn();
const saveButton = () => screen.getByRole("button", { name: /Save policies/ }) as HTMLButtonElement;

beforeEach(() => {
  save.mockReset();
  toast.mockReset();
});
afterEach(() => cleanup());

describe("the settings form", () => {
  it("🔴 saves the text and the checklist, cleaned", async () => {
    save.mockResolvedValue({ ok: true });
    render(<BookingPolicyCard initialText={null} initialChecklist={[]} toast={toast} />);
    expect(saveButton().disabled).toBe(true); // nothing to save yet

    fireEvent.change(screen.getByLabelText("Policy"), { target: { value: "  Be on time.  " } });
    const draft = screen.getByLabelText("New checklist line");
    fireEvent.change(draft, { target: { value: " I'll arrive 5 minutes early " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(draft, { target: { value: "Late counts as a no-show" } });
    fireEvent.keyDown(draft, { key: "Enter" });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      bookingPolicyText: "Be on time.",
      bookingPolicyChecklist: ["I'll arrive 5 minutes early", "Late counts as a no-show"],
    });
    expect(await screen.findByText("Saved. Your booking page shows this now.")).toBeTruthy();
    // Saved state is the new baseline: nothing left to save.
    expect(saveButton().disabled).toBe(true);
  });

  it("clearing everything saves OFF, and says the page shows nothing", async () => {
    save.mockResolvedValue({ ok: true });
    render(
      <BookingPolicyCard initialText="Old policy" initialChecklist={["Old line"]} toast={toast} />,
    );
    fireEvent.change(screen.getByLabelText("Policy"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove checklist line 1" }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ bookingPolicyText: null, bookingPolicyChecklist: [] }),
    );
    expect(await screen.findByText("Saved. Your booking page shows no policies.")).toBeTruthy();
  });

  it("a failed save says so on the card and keeps what was typed", async () => {
    save.mockResolvedValue({ ok: false, error: "failed" });
    render(<BookingPolicyCard initialText={null} initialChecklist={[]} toast={toast} />);
    fireEvent.change(screen.getByLabelText("Policy"), { target: { value: "Keep me" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
    expect((screen.getByLabelText("Policy") as HTMLTextAreaElement).value).toBe("Keep me");
    expect(saveButton().disabled).toBe(false);
  });

  it("shows the eight-line limit instead of offering a ninth", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`);
    render(<BookingPolicyCard initialText={null} initialChecklist={eight} toast={toast} />);
    expect(screen.queryByLabelText("New checklist line")).toBeNull();
    expect(screen.getByText(/most lines a customer is asked to tick/)).toBeTruthy();
  });

  it("caps what can be typed at the shared limits", () => {
    render(<BookingPolicyCard initialText={null} initialChecklist={["a"]} toast={toast} />);
    expect(screen.getByLabelText("Policy").getAttribute("maxLength")).toBe("2000");
    expect(screen.getByLabelText("New checklist line").getAttribute("maxLength")).toBe("160");
    expect(screen.getByLabelText("Checklist line 1").getAttribute("maxLength")).toBe("160");
  });
});
