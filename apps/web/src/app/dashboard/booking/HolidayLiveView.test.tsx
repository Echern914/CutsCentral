import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServiceRow } from "./page";

vi.mock("./actions", () => ({ saveHolidayAction: vi.fn() }));

const { HolidayPricing } = await import("./HolidayPricing");

/**
 * Drick, on the Holiday pricing card: "This should show the 'open live view'
 * so I can select specific prices and TIMES available for that day". Every
 * holiday still ahead opens its day; the form does too once it holds one date;
 * a holiday already run as a special day says so on its row.
 */
const services = [
  { id: "cut", name: "Cut", active: true, price: 40, dateOverrides: { "2026-11-26": 75, "2026-10-01": 50 } },
  { id: "beard", name: "Beard", active: true, price: 25, dateOverrides: { "2026-11-26": 75 } },
] as unknown as ServiceRow[];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00.000Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Holiday pricing: Open live view", () => {
  it("opens the holiday's day with its name and price; a passed holiday has no button", () => {
    const onOpenLiveView = vi.fn();
    render(
      <HolidayPricing
        services={services}
        names={{ "2026-11-26": "Thanksgiving" }}
        timezone="UTC"
        toast={vi.fn()}
        specialDays={{ "2026-11-26": { openings: 24, booked: 3 } }}
        onOpenLiveView={onOpenLiveView}
      />,
    );
    expect(screen.getByText("Special day: 24 openings · 3 booked")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /^Open live view/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open live view of Thanksgiving" }));
    expect(onOpenLiveView).toHaveBeenCalledWith(["2026-11-26"], "Thanksgiving", 75);
  });

  it("the holiday form opens the live view once it holds exactly one date", () => {
    const onOpenLiveView = vi.fn();
    render(<HolidayPricing services={services} timezone="UTC" toast={vi.fn()} onOpenLiveView={onOpenLiveView} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a holiday" }));
    const formButton = { name: /^Open live view - pick the times/ };
    expect(screen.queryByRole("button", formButton)).toBeNull();
    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2026-12-24" } });
    fireEvent.change(screen.getByPlaceholderText("Thanksgiving"), { target: { value: "Christmas Eve" } });
    fireEvent.change(screen.getByLabelText("Price those days"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", formButton));
    expect(onOpenLiveView).toHaveBeenCalledWith(["2026-12-24"], "Christmas Eve", 90);

    // A stretch of days is not one day: the form's button goes away.
    fireEvent.change(screen.getByLabelText("Last day (optional)"), { target: { value: "2026-12-26" } });
    expect(screen.queryByRole("button", formButton)).toBeNull();
  });
});
