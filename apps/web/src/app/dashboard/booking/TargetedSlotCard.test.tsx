import { useState, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TargetedSlotCard } from "./TargetedSlotCard";

/**
 * The collapsed targeted-slot card.
 *
 * The list used to print the schedule, the service, the barber, the length,
 * the price, the label and the counts on every row, so a dozen published slots
 * were a wall of near-identical grey text. The card shows the barber's own name
 * for it and nothing else until asked.
 *
 * These assert the DISCLOSURE contract, which is the part that breaks quietly:
 * a details block still in the DOM while "collapsed", a toggle that a screen
 * reader can't operate, an Edit button that also expands the card.
 */

const DETAIL = "Fri 9:00 PM · Skin Fade · Marcus · 45 min · $60";

function Card(props: {
  title?: string;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ul>
      <TargetedSlotCard
        title={props.title ?? "AFTER HOUR HAIRCUT"}
        subtitle="Next Fri, 9:00 PM"
        status={{ label: "Open", tone: "open" }}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        leading={props.leading}
        actions={props.actions}
      >
        <p>{DETAIL}</p>
      </TargetedSlotCard>
    </ul>
  );
}

describe("collapsed by default", () => {
  it("shows the slot's name prominently", () => {
    render(<Card />);
    expect(screen.getByText("AFTER HOUR HAIRCUT")).toBeVisible();
  });

  it("keeps the status visible - it is why you are looking", () => {
    render(<Card />);
    expect(screen.getByText("Open")).toBeVisible();
  });

  it("does NOT render the configuration detail", () => {
    // queryByText, not "not.toBeVisible": the panel must be absent from the
    // DOM entirely, or a screen reader walks content the eye cannot see.
    render(<Card />);
    expect(screen.queryByText(DETAIL)).toBeNull();
  });
});

describe("expanding and collapsing", () => {
  it("reveals the detail on click and hides it again on a second click", async () => {
    const user = userEvent.setup();
    render(<Card />);
    const toggle = screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ });

    await user.click(toggle);
    expect(screen.getByText(DETAIL)).toBeVisible();

    await user.click(toggle);
    expect(screen.queryByText(DETAIL)).toBeNull();
  });

  it("reports its state with aria-expanded", async () => {
    const user = userEvent.setup();
    render(<Card />);
    const toggle = screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("points aria-controls at the panel that is actually rendered", async () => {
    const user = userEvent.setup();
    render(<Card />);
    const toggle = screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ });
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();

    await user.click(toggle);
    const panel = document.getElementById(panelId as string);
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent(DETAIL);
  });
});

describe("keyboard", () => {
  it("opens with Enter", async () => {
    const user = userEvent.setup();
    render(<Card />);
    await user.tab(); // focus lands on the disclosure
    expect(screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByText(DETAIL)).toBeVisible();
  });

  it("opens with Space", async () => {
    const user = userEvent.setup();
    render(<Card />);
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByText(DETAIL)).toBeVisible();
  });

  it("is reachable by keyboard at all - it is a real button, not a div", () => {
    // A div with onClick would pass every click test above and be completely
    // unusable without a mouse.
    render(<Card />);
    expect(
      screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ }).tagName,
    ).toBe("BUTTON");
  });
});

describe("the row actions stay independent", () => {
  it("Edit fires without expanding the card", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<Card actions={<button onClick={onEdit}>Edit</button>} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    // Still collapsed: Edit is not a disclosure.
    expect(screen.queryByText(DETAIL)).toBeNull();
  });

  it("Turn off fires without expanding the card", async () => {
    const user = userEvent.setup();
    const onOff = vi.fn();
    render(<Card actions={<button onClick={onOff}>Turn off</button>} />);

    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(onOff).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(DETAIL)).toBeNull();
  });

  it("a leading checkbox ticks without expanding the card", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Card leading={<input type="checkbox" aria-label="Select" onChange={onPick} />} />);

    await user.click(screen.getByRole("checkbox", { name: "Select" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(DETAIL)).toBeNull();
  });

  it("never nests interactive content inside the disclosure button", () => {
    // A <button> containing a <button> or an <input> is invalid HTML, and
    // browsers resolve the click ambiguity differently. This is why `leading`
    // and `actions` are siblings of the toggle rather than its children.
    render(
      <Card
        leading={<input type="checkbox" aria-label="Select" readOnly />}
        actions={<button>Edit</button>}
      />,
    );
    const toggle = screen.getByRole("button", { name: /AFTER HOUR HAIRCUT/ });
    expect(toggle.querySelector("button, input, a, select, textarea")).toBeNull();
  });
});

describe("mobile", () => {
  it("truncates a very long name instead of pushing the actions off-screen", () => {
    // The "zoomed in" bug in this codebase has twice been a flex child with no
    // min-w-0. Both the row and the text block need it.
    render(
      <Card
        title="AFTER HOUR HAIRCUT WITH THE FULL BEARD LINE-UP AND HOT TOWEL FINISH"
        actions={<button>Edit</button>}
      />,
    );
    const title = screen.getByText(/AFTER HOUR HAIRCUT WITH/);
    expect(title).toHaveClass("truncate");

    const toggle = screen.getByRole("button", { name: /AFTER HOUR HAIRCUT WITH/ });
    expect(toggle).toHaveClass("min-w-0");
  });
});
