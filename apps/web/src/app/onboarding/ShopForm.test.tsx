import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * Setup step 1 asks only what can't be known already:
 *  - the texting agreement only of someone who didn't give it at signup;
 *  - the business type pre-picked when they came from that type's page;
 *  - the time zone read from their device;
 *  - no booking link or reward (their own steps now), and the referral code
 *    behind a link.
 */
vi.mock("./actions", () => ({ createShopAction: vi.fn(async () => ({})) }));
// useFormState / useFormStatus ship in Next's React build, not the plain one
// the tests run: stand in for them (the form's submit is the action's test).
vi.mock("react-dom", async () => {
  const real = await vi.importActual<typeof import("react-dom")>("react-dom");
  return {
    ...real,
    useFormState: (_action: unknown, initial: unknown) => [initial, vi.fn()],
    useFormStatus: () => ({ pending: false }),
  };
});
vi.mock("../dashboard/actions", () => ({ saveThemeAction: vi.fn() }));
vi.mock("@/components/TrackConversion", () => ({ TrackConversion: () => null }));
vi.mock("@/components/ThemePicker", () => ({ ThemePicker: () => null }));

const { ShopForm } = await import("./ShopForm");

describe("setup step 1", () => {
  it("🔴 agreed at signup: the texting box isn't asked again", () => {
    render(<ShopForm smsAttested initialType="" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("not agreed yet (Google or Apple): the box is there and required", () => {
    render(<ShopForm smsAttested={false} initialType="" />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).required).toBe(true);
  });

  it("came from a business type's page: pre-picked", () => {
    render(<ShopForm smsAttested initialType="nails" />);
    expect((screen.getByLabelText("What kind of business are you setting up?") as HTMLSelectElement).value).toBe("nails");
  });

  it("🔴 the time zone is their device's - one that isn't the default, so ignoring it shows", async () => {
    const real = Intl.DateTimeFormat;
    const fake = Object.assign(
      () => ({ resolvedOptions: () => ({ timeZone: "Europe/Lisbon" }) }),
      { supportedLocalesOf: real.supportedLocalesOf },
    ) as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = fake;
    try {
      render(<ShopForm smsAttested initialType="" />);
      await act(async () => {});
      expect((screen.getByTestId("timezone") as HTMLSelectElement).value).toBe("Europe/Lisbon");
      expect(screen.getByText(/Time zone \(from your device\)/)).toBeTruthy();
    } finally {
      Intl.DateTimeFormat = real;
    }
  });

  it("no booking link or reward questions; the referral code is behind a link", () => {
    render(<ShopForm smsAttested initialType="" />);
    expect(screen.queryByLabelText(/Booking link/)).toBeNull();
    expect(screen.queryByLabelText(/Punches needed/)).toBeNull();
    expect(screen.queryByLabelText(/Referral code/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Have a referral code?" }));
    expect(screen.getByLabelText("Referral code (optional)")).toBeTruthy();
  });
});
