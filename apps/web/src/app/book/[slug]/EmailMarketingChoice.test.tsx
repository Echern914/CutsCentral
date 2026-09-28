import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EmailMarketingChoice, emailMarketingYes } from "./EmailMarketingChoice";

/**
 * "Email me news and offers" on the booking page: the customer's own yes to
 * the shop's marketing email. The API decides which record it may land on;
 * this pins the half only the page can get wrong - the box is unticked, it
 * appears only with an address, and nothing is sent without a tick.
 */

const props = { shopName: "Marcus Reed Studio", checked: false, onChange: () => {} };

describe("the box", () => {
  it("is not shown until an email is entered", () => {
    const { rerender } = render(<EmailMarketingChoice {...props} email="" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(<EmailMarketingChoice {...props} email="   " />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("🔴 appears UNTICKED with an email, and names the shop", () => {
    render(<EmailMarketingChoice {...props} email="marcus@example.com" />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(
      screen.getByText("Email me news and offers from Marcus Reed Studio. You can unsubscribe anytime."),
    ).toBeTruthy();
  });

  it("a tick is reported up; nothing ticks it for them", () => {
    const onChange = vi.fn();
    render(<EmailMarketingChoice {...props} email="marcus@example.com" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("what the booking sends", () => {
  it("🔴 nothing without a tick", () => {
    expect(emailMarketingYes(false, "marcus@example.com")).toBeUndefined();
  });

  it("nothing without an address, even if the box was ticked before it was cleared", () => {
    expect(emailMarketingYes(true, "")).toBeUndefined();
    expect(emailMarketingYes(true, "  ")).toBeUndefined();
  });

  it("true for a tick with an address", () => {
    expect(emailMarketingYes(true, "marcus@example.com")).toBe(true);
  });
});
