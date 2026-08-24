import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShopWaitlistForm } from "./ShopWaitlistForm";
import { joinWaitlistAction } from "./actions";

vi.mock("./actions", () => ({
  joinWaitlistAction: vi.fn(async () => ({ ok: true })),
}));

/**
 * The SHOP-PAGE entry point. The booking page's form got structured windows +
 * consent in the waitlist client-flow PR; this form lagged behind on the old
 * free-text "Preferred time" box, which meant a shop-page joiner could never
 * record SMS consent and their preference could never be matched. These pin
 * the parity: same rows, same consent contract, same wire shape - through the
 * shop page's own themed markup.
 */

const theme = {
  surface: "#141414",
  border: "#333333",
  muted: "#999999",
  scheme: "dark" as const,
  radius: "1rem",
  buttonRadius: "9999px",
};
const props = { slug: "cuts", shopName: "Cuts", accent: "#c9a24a", theme };

const open = () => fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
const join = () => fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
const mockJoin = vi.mocked(joinWaitlistAction);

beforeEach(() => mockJoin.mockClear());

describe("collapsed by default", () => {
  it("expands on tap and moves focus into the form", () => {
    render(<ShopWaitlistForm {...props} />);
    expect(screen.queryByLabelText("Your name")).toBeNull();
    open();
    const name = screen.getByLabelText("Your name");
    expect(document.activeElement).toBe(name);
  });

  it("preview mode never expands (the dashboard's page preview is inert)", () => {
    render(<ShopWaitlistForm {...props} preview />);
    open();
    expect(screen.queryByLabelText("Your name")).toBeNull();
  });
});

describe("windows, not free text", () => {
  it("🔴 the old free-text box is gone; the rows are offered instead", () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    expect(screen.queryByLabelText("Preferred time")).toBeNull();
    expect(screen.getByRole("group", { name: "Dates for option 1" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Times for option 1" })).toBeTruthy();
    // Any/Any is the pressed default - the one-tap case.
    expect(screen.getByText("Any date").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Any time").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers up to five options and no more", () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    const add = () => screen.queryByText("+ Add another option");
    for (let i = 0; i < 4; i++) {
      expect(add(), `add link before option ${i + 2}`).toBeTruthy();
      fireEvent.click(add()!);
    }
    expect(screen.getByText("Option 5")).toBeTruthy();
    expect(add()).toBeNull();
  });

  it("surfaces a row error instead of submitting half a window", () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    fireEvent.click(screen.getByText("A date"));
    join();
    expect(screen.getByRole("alert").textContent).toMatch(/pick a date/i);
    expect(mockJoin).not.toHaveBeenCalled();
  });
});

describe("🔴 consent ships unchecked and is never required", () => {
  it("appears only once a phone is typed, unchecked, with the STOP sentence", () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Reply STOP to opt out/i)).toBeTruthy();
  });
});

describe("the wire shape", () => {
  it("a default join sends one Any/Any window, the browser zone, and NO consent", async () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    join();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mockJoin).toHaveBeenCalledWith("cuts", {
      firstName: "Sam",
      phone: "3025550100",
      email: undefined,
      windows: [{ startDate: null, endDate: null, startMin: null, endMin: null }],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      smsConsent: false,
    });
  });

  it("a ticked box with a phone sends smsConsent: true", async () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    join();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mockJoin.mock.calls[0]![1]).toMatchObject({ smsConsent: true });
  });

  it("a picked date rides along as a real window", async () => {
    render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "s@test.local" } });
    fireEvent.click(screen.getByText("A date"));
    fireEvent.change(screen.getByLabelText("Option 1 date"), {
      target: { value: "2026-08-29" },
    });
    join();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mockJoin.mock.calls[0]![1]).toMatchObject({
      windows: [{ startDate: "2026-08-29", endDate: "2026-08-29", startMin: null, endMin: null }],
    });
  });
});

describe("the confirmation", () => {
  it("an email join mentions the cancel link; a phone-only join does not", async () => {
    const { unmount } = render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "s@test.local" } });
    join();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/take yourself back off the list/i)).toBeTruthy();
    unmount();

    render(<ShopWaitlistForm {...props} />);
    open();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    join();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByText(/take yourself back off the list/i)).toBeNull();
  });
});
