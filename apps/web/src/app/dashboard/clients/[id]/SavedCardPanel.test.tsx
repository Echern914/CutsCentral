import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SavedCardPanel } from "./SavedCardPanel";

/**
 * "Card on file" on the client's profile - the owner: "in the client database
 * they can also have their card on file there". Display facts only, and the
 * uses the client agreed to, in words the barber can repeat.
 */
describe("the client's card on file", () => {
  it("shows brand, last four, expiry and when they saved it", () => {
    render(
      <SavedCardPanel
        card={{ brand: "visa", last4: "4242", expMonth: 8, expYear: 2030, savedAt: "2026-09-30T18:59:12.000Z" }}
        timezone="America/New_York"
      />,
    );
    expect(screen.getByText(/Visa •••• 4242/)).toBeTruthy();
    expect(screen.getByText(/expires 08\/30/)).toBeTruthy();
    expect(screen.getByText(/Saved by the client on Sep 30, 2026/)).toBeTruthy();
    // What it is used for - and that only the client can take it off.
    expect(screen.getByText(/no-show or late cancellation is charged under your policy/)).toBeTruthy();
    expect(screen.getByText(/Only the client can remove it/)).toBeTruthy();
  });

  it("offers no free-form charge button - only the uses the client agreed to", () => {
    render(
      <SavedCardPanel
        card={{ brand: null, last4: null, expMonth: null, expYear: null, savedAt: "2026-09-30T18:59:12.000Z" }}
        timezone="UTC"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Card")).toBeTruthy();
  });
});
