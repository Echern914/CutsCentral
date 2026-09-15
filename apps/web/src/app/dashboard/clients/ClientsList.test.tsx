import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientsList, type ClientRow } from "./ClientsList";

vi.mock("../actions", () => ({ bulkClientAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const row = (over: Partial<ClientRow>): ClientRow => ({
  id: "c1",
  name: "Jay",
  phone: "+15555550100",
  email: null,
  optedOut: false,
  smsConsent: true,
  source: "acuity",
  lastVisitAt: null,
  medianIntervalDays: null,
  loyaltyTier: null,
  frequencySegment: null,
  balance: 0,
  ...over,
});

/**
 * A row the shop never named can show the customer's own name - and must say
 * where it came from, so a barber never mistakes it for their own record.
 */
describe("ClientsList names", () => {
  it("marks a name that came from the customer's app", () => {
    render(<ClientsList clients={[row({ id: "a", name: "Maya Lee", nameFromApp: true })]} />);
    expect(screen.getByText("Maya Lee")).toBeTruthy();
    expect(screen.getByText("name from app")).toBeTruthy();
  });

  it("says nothing extra about a name the shop recorded itself", () => {
    render(<ClientsList clients={[row({ id: "b", name: "Jay" })]} />);
    expect(screen.getByText("Jay")).toBeTruthy();
    expect(screen.queryByText("name from app")).toBeNull();
  });
});
