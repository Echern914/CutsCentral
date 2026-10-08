import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServiceRow } from "./page";

vi.mock("./actions", () => ({ updateServiceAction: vi.fn(async () => ({ ok: true })) }));

const { HolidayPricing } = await import("./HolidayPricing");

/**
 * 🔴 "TODAY" IS THE SHOP'S DATE. It was the UTC date, which from 7 PM Eastern
 * is already tomorrow: today could not be picked, and today's holiday was
 * dimmed as passed.
 */
const svc = {
  id: "s1",
  name: "Cut",
  active: true,
  price: 40,
  dateOverrides: { "2026-12-24": 60 },
} as unknown as ServiceRow;

beforeEach(() => {
  // 8 PM Eastern on Christmas Eve = 01:00 UTC on Christmas Day.
  vi.useFakeTimers({ now: new Date("2026-12-25T01:00:00.000Z"), toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("Holiday pricing on a US evening", () => {
  it("today can still be picked", () => {
    render(<HolidayPricing services={[svc]} timezone="America/New_York" toast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a holiday" }));
    expect((screen.getByLabelText("First day") as HTMLInputElement).min).toBe("2026-12-24");
  });
});
