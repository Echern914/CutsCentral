import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow } from "./page";

const saveHolidayAction = vi.fn();
vi.mock("./actions", () => ({ saveHolidayAction: (...a: unknown[]) => saveHolidayAction(...a) }));

const { HolidayPricing } = await import("./HolidayPricing");

/**
 * Drick: "Also need to be able to edit the holiday and name it". The name
 * shows on the row; Edit opens the form on the saved holiday; Save sends ONE
 * request that takes the old dates off and writes the new ones (the server
 * does it in one transaction, so nothing half-lands).
 */
const services = [
  { id: "cut", name: "Cut", active: true, price: 40, dateOverrides: { "2026-11-26": 75 } },
  { id: "beard", name: "Beard", active: true, price: 25, dateOverrides: { "2026-11-26": 75 } },
  { id: "kids", name: "Kids", active: true, price: 20, dateOverrides: {} },
] as unknown as ServiceRow[];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00.000Z"), toFake: ["Date"] });
  saveHolidayAction.mockResolvedValue({ ok: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  saveHolidayAction.mockReset();
});

describe("Holiday pricing: names and edit", () => {
  it("shows the holiday's name on its row", () => {
    render(<HolidayPricing services={services} names={{ "2026-11-26": "Thanksgiving" }} timezone="UTC" toast={vi.fn()} />);
    expect(screen.getByText("Thanksgiving")).toBeTruthy();
  });

  it("Edit prefills the form and Save replaces the holiday in one request", async () => {
    const toast = vi.fn();
    render(<HolidayPricing services={services} names={{ "2026-11-26": "Thanksgiving" }} timezone="UTC" toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit holiday on/ }));

    expect((screen.getByPlaceholderText("Thanksgiving") as HTMLInputElement).value).toBe("Thanksgiving");
    expect((screen.getByLabelText("Price those days") as HTMLInputElement).value).toBe("75");
    expect(screen.getByRole("button", { name: /^Cut/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Kids/ }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(screen.getByPlaceholderText("Thanksgiving"), { target: { value: "Turkey Day" } });
    fireEvent.change(screen.getByLabelText("Price those days"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveHolidayAction).toHaveBeenCalledTimes(1));
    expect(saveHolidayAction).toHaveBeenCalledWith({
      removeDates: ["2026-11-26"],
      dates: ["2026-11-26"],
      price: 80,
      serviceIds: ["cut", "beard"],
      name: "Turkey Day",
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Turkey Day updated", "success"));
  });

  it("a failed save says nothing changed and keeps the form open", async () => {
    saveHolidayAction.mockResolvedValue({ ok: false, error: "failed" });
    const toast = vi.fn();
    render(<HolidayPricing services={services} names={{}} timezone="UTC" toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit holiday on/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/nothing was changed/), "error"));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("Remove clears the whole stretch in one request", async () => {
    render(<HolidayPricing services={services} names={{}} timezone="UTC" toast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove holiday pricing on/ }));
    await waitFor(() => expect(saveHolidayAction).toHaveBeenCalledWith({ removeDates: ["2026-11-26"] }));
  });
});
