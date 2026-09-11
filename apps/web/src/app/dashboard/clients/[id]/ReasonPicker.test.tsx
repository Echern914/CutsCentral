import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReasonPicker } from "./ReasonPicker";

/**
 * Every manual punch change carries a reason. The picker makes the common ones
 * a single tap and never submits an empty one.
 */
describe("ReasonPicker", () => {
  it("a preset is one tap", () => {
    const onPick = vi.fn();
    render(<ReasonPicker prompt="Why?" presets={["Referral", "Promotion"]} busy={false} onPick={onPick} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Referral"));
    expect(onPick).toHaveBeenCalledWith("Referral");
  });

  it("'Other' takes a few words, trimmed - and refuses a blank", () => {
    const onPick = vi.fn();
    render(<ReasonPicker prompt="Why?" presets={["Referral"]} busy={false} onPick={onPick} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Other…"));
    const input = screen.getByLabelText("Reason");
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  Birthday  " } });
    fireEvent.click(screen.getByText("Save"));
    expect(onPick).toHaveBeenCalledWith("Birthday");
  });

  it("cancel writes nothing", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    render(<ReasonPicker prompt="Why?" presets={["Referral"]} busy={false} onPick={onPick} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});
