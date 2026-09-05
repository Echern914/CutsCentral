import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";

/**
 * The banner both booking forms show when the API refuses to write over time
 * the barber blocked in Acuity. What it must never get wrong:
 *
 *  - the server's sentence is shown VERBATIM and as TEXT (a block's reason is
 *    whatever someone typed into Acuity - it comes back out as content, never
 *    as markup);
 *  - it takes focus, because the Save it answers lives in a sticky footer and
 *    the barber may be scrolled nowhere near it;
 *  - confirming hands back the digest that came with THIS refusal;
 *  - a refusal with no confirmation offers no way to confirm.
 */
const conflict = (over: Partial<BlockConflict> = {}): BlockConflict => ({
  reason: "Blocked in your external calendar: Dentist, Sep 10, 12:00 PM - 2:00 PM",
  confirmation: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  ...over,
});

const props = {
  pending: false,
  confirmLabel: "Save over this block",
  pendingLabel: "Saving…",
  consequence: "It will be recorded as an override.",
};

describe("ExternalBlockBanner", () => {
  it("shows the server's sentence exactly, and takes focus", () => {
    render(
      <ExternalBlockBanner
        {...props}
        conflict={conflict()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByRole("alertdialog");
    expect(banner).toHaveTextContent(
      "Blocked in your external calendar: Dentist, Sep 10, 12:00 PM - 2:00 PM",
    );
    expect(document.activeElement).toBe(banner);
    // An assertive live region, so it is announced even where a programmatic
    // focus change alone would not be.
    expect(banner).toHaveAttribute("aria-live", "assertive");
    expect(banner).toHaveAccessibleName(
      "Blocked in your external calendar: Dentist, Sep 10, 12:00 PM - 2:00 PM",
    );
  });

  it("🔴 renders a hostile reason as text, never as markup", () => {
    const nasty = '<img src=x onerror="alert(1)"> <script>alert(2)</script> Dentist';
    const { container } = render(
      <ExternalBlockBanner
        {...props}
        conflict={conflict({ reason: nasty })}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(nasty);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("confirming and dismissing each call exactly their own handler", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ExternalBlockBanner
        {...props}
        conflict={conflict()}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose another time" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("🔴 offers no way to confirm when the refusal carried no confirmation", () => {
    render(
      <ExternalBlockBanner
        {...props}
        conflict={conflict({ confirmation: "" })}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Save over this block" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose another time" })).toBeInTheDocument();
  });

  it("while a confirmed save runs, both buttons are disabled and the label says so", () => {
    render(
      <ExternalBlockBanner
        {...props}
        pending
        conflict={conflict()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Saving…" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose another time" })).toBeDisabled();
  });

  it("takes focus AGAIN when the conflict changes underneath it", () => {
    const { rerender } = render(
      <ExternalBlockBanner
        {...props}
        conflict={conflict()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // Something else takes focus - the barber tabbed away.
    (screen.getByRole("button", { name: "Choose another time" }) as HTMLElement).focus();
    expect(document.activeElement).not.toBe(screen.getByRole("alertdialog"));
    rerender(
      <ExternalBlockBanner
        {...props}
        conflict={conflict({ reason: "Blocked in your external calendar: School run", confirmation: "ffff" })}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("School run");
  });
});
