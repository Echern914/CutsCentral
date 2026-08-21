import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MinutesField, MinutesNumberField, MoneyField } from "./UnitField";

/**
 * The rendered price and length fields.
 *
 * The defect these exist to kill is invisible to a logic test: the unit was a
 * PLACEHOLDER, so "Minutes" and "Price ($)" were on screen right up until the
 * moment you typed, and then the box just held "45" with nothing to say what
 * 45 meant. So the assertions below are deliberately about what is on screen
 * AFTER typing, not before.
 */

function ControlledMoney({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <MoneyField value={v} onChange={setV} />;
}

function ControlledMinutes({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <MinutesField value={v} onChange={setV} />;
}

function ControlledMinutesNumber({ initial = 30 }: { initial?: number }) {
  const [v, setV] = useState(initial);
  return <MinutesNumberField value={v} onChange={setV} />;
}

describe("MoneyField", () => {
  it("labels the field 'Price' with a real label, not a placeholder", () => {
    render(<ControlledMoney />);
    // getByLabelText only passes if a <label> is actually associated with the
    // input - a placeholder would not satisfy it.
    expect(screen.getByLabelText("Price")).toBeInTheDocument();
  });

  it("shows the $ and KEEPS it visible once a value is typed", async () => {
    const user = userEvent.setup();
    render(<ControlledMoney />);
    expect(screen.getByText("$")).toBeVisible();

    await user.type(screen.getByLabelText("Price"), "45");

    expect(screen.getByLabelText("Price")).toHaveValue(45);
    // The whole point: still there.
    expect(screen.getByText("$")).toBeVisible();
  });

  it("renders exactly ONE dollar sign - never '$$'", async () => {
    const user = userEvent.setup();
    render(<ControlledMoney />);
    await user.type(screen.getByLabelText("Price"), "45");

    const dollars = screen.getAllByText("$");
    expect(dollars).toHaveLength(1);
    // And the label itself must not carry a second one.
    expect(screen.getByLabelText("Price").getAttribute("aria-label")).toBeNull();
    expect(document.body.textContent).not.toContain("$$");
  });

  it("marks itself invalid and announces the reason", () => {
    render(
      <MoneyField value="-5" onChange={() => {}} error="Price can't be negative" />,
    );
    const input = screen.getByLabelText("Price");
    expect(input).toHaveAttribute("aria-invalid", "true");

    // role=alert so the message is announced when it appears (FormError).
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Price can't be negative");
    // ...and tied to the field, so AT reads them together.
    expect(input.getAttribute("aria-describedby")).toBe(alert.getAttribute("id"));
  });

  it("is not marked invalid when there is no error", () => {
    render(<ControlledMoney initial="45" />);
    expect(screen.getByLabelText("Price")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("can be emptied - blank is a real value here", async () => {
    const user = userEvent.setup();
    render(<ControlledMoney initial="45" />);
    const input = screen.getByLabelText("Price");
    await user.clear(input);
    expect(input).toHaveValue(null);
  });
});

describe("MinutesField", () => {
  it("labels the field 'Duration' and shows a 'min' unit", () => {
    render(<ControlledMinutes />);
    expect(screen.getByLabelText("Duration")).toBeInTheDocument();
    expect(screen.getByText("min")).toBeVisible();
  });

  it("KEEPS the unit visible once a value is typed", async () => {
    const user = userEvent.setup();
    render(<ControlledMinutes />);
    await user.type(screen.getByLabelText("Duration"), "30");

    expect(screen.getByLabelText("Duration")).toHaveValue(30);
    expect(screen.getByText("min")).toBeVisible();
  });

  it("renders the unit exactly once - never '30 min min'", async () => {
    const user = userEvent.setup();
    render(<ControlledMinutes />);
    await user.type(screen.getByLabelText("Duration"), "30");

    expect(screen.getAllByText("min")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/min\s*min/);
  });

  it("keeps the unit OUT of the accessible name", () => {
    // If the label said "Duration (min)" a screen reader would read the unit
    // twice - once from the label, once from the suffix. The suffix is
    // aria-hidden and the label is clean.
    render(<ControlledMinutes />);
    expect(screen.getByLabelText("Duration")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Duration \(min\)/)).toBeNull();
  });
});

describe("MinutesNumberField", () => {
  it("looks identical to the string-valued one", () => {
    render(<ControlledMinutesNumber />);
    expect(screen.getByLabelText("Duration")).toHaveValue(30);
    expect(screen.getByText("min")).toBeVisible();
  });

  it("can be cleared while typing without snapping back to a stuck 0", async () => {
    // This is why it wraps NumberField rather than binding a number straight to
    // the input: Number("") is 0, so a naive numeric field can never be empty
    // and "40" becomes "040".
    const user = userEvent.setup();
    render(<ControlledMinutesNumber initial={30} />);
    const input = screen.getByLabelText("Duration");
    await user.clear(input);
    expect(input).toHaveValue(null);

    await user.type(input, "45");
    expect(input).toHaveValue(45);
  });
});

describe("shared chrome", () => {
  it("lets a grid hide the label visually while keeping it for screen readers", () => {
    render(<MoneyField value="" onChange={() => {}} srOnlyLabel />);
    // Still reachable by its accessible name...
    const input = screen.getByLabelText("Price");
    expect(input).toBeInTheDocument();
    // ...but the visible label is the sr-only kind.
    expect(document.querySelector("label")).toHaveClass("sr-only");
  });

  it("does not point aria-describedby at a hint that isn't rendered", () => {
    // A dangling reference makes AT announce nothing at all, which is worse
    // than no reference.
    render(<MoneyField value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Price")).not.toHaveAttribute("aria-describedby");
  });

  it("ties a hint to the field when there is one", () => {
    render(<MoneyField value="" onChange={() => {}} hint="Leave blank to use the base price" />);
    const input = screen.getByLabelText("Price");
    const hintId = input.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)).toHaveTextContent(
      "Leave blank to use the base price",
    );
  });
});
