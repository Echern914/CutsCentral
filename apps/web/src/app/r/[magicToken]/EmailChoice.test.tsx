import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewardsTheme } from "./theme";

/**
 * The customer's own on/off for a shop's marketing email, on their rewards
 * page. On records their yes; Off is the unsubscribe link's own write (the
 * API test pins that). Here: the right line and the right switch per state,
 * and the promise that appointment emails keep coming.
 */

const emailMarketingAction = vi.fn();
vi.mock("./actions", () => ({
  emailMarketingAction: (...a: unknown[]) => emailMarketingAction(...a),
}));

const { EmailChoice } = await import("./EmailChoice");

beforeEach(() => emailMarketingAction.mockReset());

const theme = { muted: "#999", accent: "#c9a24a" } as unknown as RewardsTheme;
const show = (initialState: "opted_in" | "needs_consent" | "opted_out") =>
  render(<EmailChoice magicToken="tok" shopName="Marcus Reed Studio" theme={theme} initialState={initialState} />);

describe("EmailChoice", () => {
  it("not yet: asks, and says appointment emails come either way", () => {
    show("needs_consent");
    expect(screen.getByText(/Want news and offers from Marcus Reed Studio by email\?/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Email me news and offers" })).toBeTruthy();
    expect(screen.getByText("You'll still get emails about your appointments.")).toBeTruthy();
  });

  it("On sends their yes and shows the way back out", async () => {
    emailMarketingAction.mockResolvedValue({ ok: true, state: "opted_in" });
    show("needs_consent");
    fireEvent.click(screen.getByRole("button", { name: "Email me news and offers" }));
    await waitFor(() => expect(emailMarketingAction).toHaveBeenCalledWith("tok", true));
    expect(await screen.findByRole("button", { name: "Stop these emails" })).toBeTruthy();
  });

  it("Off sends the unsubscribe, then says how to get them back - with no button here", async () => {
    emailMarketingAction.mockResolvedValue({ ok: true, state: "opted_out" });
    show("opted_in");
    fireEvent.click(screen.getByRole("button", { name: "Stop these emails" }));
    await waitFor(() => expect(emailMarketingAction).toHaveBeenCalledWith("tok", false));
    expect(await screen.findByText(/You've unsubscribed from Marcus Reed Studio's news and offers emails\./)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("🔴 unsubscribed: no way to turn emails back on here, only how to", () => {
    show("opted_out");
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText(/open the Unsubscribe link at the bottom of one of their emails and press Resubscribe/),
    ).toBeTruthy();
  });

  it("an On refused because they unsubscribed meanwhile shows how, not a failure", async () => {
    emailMarketingAction.mockResolvedValue({ ok: false, error: "unsubscribed" });
    show("needs_consent");
    fireEvent.click(screen.getByRole("button", { name: "Email me news and offers" }));
    expect(await screen.findByText(/press Resubscribe/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failure says so and keeps the state", async () => {
    emailMarketingAction.mockResolvedValue({ ok: false, error: "failed" });
    show("opted_in");
    fireEvent.click(screen.getByRole("button", { name: "Stop these emails" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Please try again.");
    expect(screen.getByRole("button", { name: "Stop these emails" })).toBeTruthy();
  });
});
