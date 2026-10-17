import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * The shop's time zone, put right under Booking → Settings: the current zone
 * shown, a change explained before it's saved (bookings keep their moment),
 * saved once however fast the taps, a refusal on screen.
 */
// A plain function, not vi.fn(): a vi.fn() holding a promise crashes the test
// worker whenever any test in this file fails, so a broken guard hung instead
// of failing.
const save = vi.hoisted(() => ({ impl: (_zone: string): Promise<unknown> => new Promise(() => {}) }));
vi.mock("./actions", () => ({ saveShopTimezoneAction: (zone: string) => save.impl(zone) }));

const { ShopTimezoneCard } = await import("./ShopTimezoneCard");

beforeEach(() => {
  save.impl = () => new Promise(() => {});
});

describe("shop time zone", () => {
  it("shows the current zone, and Save only once it's changed", () => {
    render(<ShopTimezoneCard current="America/Chicago" />);
    expect((screen.getByLabelText("Shop time zone") as HTMLSelectElement).value).toBe("America/Chicago");
    expect(screen.queryByRole("button", { name: "Save time zone" })).toBeNull();
  });

  it("🔴 a change says what happens to bookings before it's saved", () => {
    render(<ShopTimezoneCard current="America/New_York" />);
    fireEvent.change(screen.getByLabelText("Shop time zone"), { target: { value: "America/Los_Angeles" } });
    expect(screen.queryByTestId("timezone-warning")?.textContent ?? "").toMatch(
      /Bookings already made keep their moment/,
    );
  });

  it("🔴 saves once, however fast the taps", async () => {
    const asked: string[] = [];
    let answer!: (v: unknown) => void;
    save.impl = (zone: string) => {
      asked.push(zone);
      return new Promise((r) => (answer = r));
    };
    render(<ShopTimezoneCard current="America/New_York" />);
    fireEvent.change(screen.getByLabelText("Shop time zone"), { target: { value: "America/Los_Angeles" } });
    const btn = screen.getByRole("button", { name: "Save time zone" });
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(asked).toEqual(["America/Los_Angeles"]);
    await act(async () => answer({ ok: true }));
    expect(screen.queryByRole("button", { name: "Save time zone" })).toBeNull();
  });

  it("a zone outside the US list, already set, is kept and shown", () => {
    render(<ShopTimezoneCard current="Europe/London" />);
    expect((screen.getByLabelText("Shop time zone") as HTMLSelectElement).value).toBe("Europe/London");
  });

  it("a refusal stays on screen", async () => {
    save.impl = async () => ({ ok: false, error: "invalid_input" });
    render(<ShopTimezoneCard current="America/New_York" />);
    fireEvent.change(screen.getByLabelText("Shop time zone"), { target: { value: "America/Denver" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save time zone" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't change the time zone/);
  });
});
