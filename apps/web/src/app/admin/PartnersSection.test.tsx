import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PartnersSection, type AdminPartners } from "./PartnersSection";
import { createPartnerAction, markPartnerCashoutPaidAction, setPartnerActiveAction } from "./actions";

vi.mock("./actions", () => ({
  createPartnerAction: vi.fn(async () => ({ ok: true })),
  setPartnerActiveAction: vi.fn(async () => ({ ok: true })),
  markPartnerCashoutPaidAction: vi.fn(async () => ({ ok: true })),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * The admin's partner desk: each button is one API call, and a failed call
 * says nothing changed instead of pretending it did.
 */

const data: AdminPartners = {
  partners: [
    {
      id: "p1",
      name: "Eric C",
      code: "ERIC C",
      email: "eric@test.local",
      active: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      standing: {
        signups: 7,
        qualified: 5,
        unlock: { unlocked: true, window: null },
        earnedCents: 2500,
        lockedCents: 0,
        availableCents: 0,
        requestedCents: 2500,
        paidOutCents: 0,
      },
    },
  ],
  pendingCashouts: [
    { id: "c1", partnerId: "p1", partnerName: "Eric C", amountCents: 2500, requestedAt: "2026-09-20T00:00:00.000Z" },
  ],
};

beforeEach(() => {
  vi.mocked(markPartnerCashoutPaidAction).mockReset();
  vi.mocked(createPartnerAction).mockReset();
  refresh.mockReset();
  toast.mockReset();
});

describe("partners desk", () => {
  it("lists codes, referrals, balance and unlock state", () => {
    render(<PartnersSection data={data} />);
    expect(screen.getByText("ERIC C")).toBeInTheDocument();
    expect(screen.getByText("7 / 5")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
  });

  it("mark paid is one call for that cashout, confirmed only after the server says so", async () => {
    vi.mocked(markPartnerCashoutPaidAction).mockResolvedValue({ ok: true });
    render(<PartnersSection data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(markPartnerCashoutPaidAction).toHaveBeenCalledWith("c1");
    expect(toast).toHaveBeenCalledWith("Marked $25 paid", "success");
  });

  it("a failed mark-paid says nothing changed", async () => {
    vi.mocked(markPartnerCashoutPaidAction).mockResolvedValue({ ok: false, error: "already_paid" });
    render(<PartnersSection data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("That didn't go through. Nothing changed.", "error"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pause sends the flip for that partner", async () => {
    render(<PartnersSection data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(setPartnerActiveAction).toHaveBeenCalledWith("p1", false));
  });

  it("a taken code is explained on the form", async () => {
    vi.mocked(createPartnerAction).mockResolvedValue({ ok: false, error: "code_taken" });
    render(<PartnersSection data={data} />);
    fireEvent.change(screen.getByLabelText("Partner name"), { target: { value: "Copy" } });
    fireEvent.change(screen.getByLabelText("Partner code"), { target: { value: "eric c" } });
    fireEvent.click(screen.getByRole("button", { name: "Add partner" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has that code");
    expect(createPartnerAction).toHaveBeenCalledWith("Copy", "eric c", "");
  });
});
