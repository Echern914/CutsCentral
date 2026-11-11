import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * THE CARD ON FILE, BESIDE "START CHECKOUT".
 *
 * The card a client left sat three lines down the payment ledger, so a barber
 * deciding how to take payment could not see there was one. It is now named
 * right above Start checkout - but only where checkout can charge a card at
 * all, only while the card is still held, and without promising that THIS card
 * may pay for THIS visit: that is the checkout's own answer.
 */

type Over = {
  card?: { brand: string; last4: string } | null;
  cardOnFile?: { status: string } | null;
  serviceCheckoutEnabled?: boolean;
  status?: string;
  checkedOutAt?: string | null;
};

const detailFor = (over: Over = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: over.status ?? "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Sample Client",
    serviceName: "Standard visit",
    staffName: "Sam",
    startsAt: "2026-11-18T14:00:00.000Z",
    endsAt: "2026-11-18T14:40:00.000Z",
    durationMin: 40,
    timezone: "America/New_York",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: {
      state: "unpaid",
      totalCents: 4000,
      collectedCents: 0,
      onlineCents: 0,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: 4000,
      method: null,
      card: over.card === undefined ? { brand: "visa", last4: "4242" } : over.card,
      receiptUrl: null,
      cardOnFile: over.cardOnFile === undefined ? { status: "saved" } : over.cardOnFile,
    },
    keptDeposit: null,
    tip: null,
    checkedOutAt: over.checkedOutAt ?? null,
    serviceCheckoutEnabled: over.serviceCheckoutEnabled ?? true,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  refundDepositAction: vi.fn(),
  refundTipAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-11-18T14:00:00.000Z",
  end: "2026-11-18T14:40:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

const cardRow = () => document.querySelector('[data-qa="card-on-file-row"]');
const startCheckout = () => document.querySelector('[data-qa="start-checkout"]');

async function open(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  await waitFor(() => expect(startCheckout() ?? document.body.textContent?.includes("Ticket total")).toBeTruthy());
}

beforeEach(() => {
  cleanup();
  getDetail.mockReset();
});

describe("the card on file beside Start checkout", () => {
  it("🔴 names the card right above the button, and promises nothing about charging it", async () => {
    await open(detailFor());
    expect(cardRow()!.textContent).toContain("Visa ending 4242");
    expect(cardRow()!.textContent).toContain("Card on file · kept, not charged");
    expect(cardRow()!.textContent).not.toMatch(/agreed|will be charged|can be charged/i);
    // Named once: the ledger's own card line steps aside for this row.
    expect(document.body.textContent!.match(/4242/g)).toHaveLength(1);
    // Directly above the one button it informs.
    expect(cardRow()!.nextElementSibling).toBe(startCheckout());
    expect(startCheckout()!.textContent).toBe("Start checkout");
  });

  it("🔴 not where checkout cannot charge a card at all (the original chair checkout)", async () => {
    await open(detailFor({ serviceCheckoutEnabled: false }));
    expect(startCheckout()).not.toBeNull();
    expect(cardRow()).toBeNull();
    // The ledger still names the card there, as it always did.
    expect(document.body.textContent).toContain("Card on file (kept, not charged)");
  });

  it("🔴 not for a card that is no longer held, was never saved, or has no number to name", async () => {
    for (const status of ["released", "charged", "failed", "pending"]) {
      cleanup();
      await open(detailFor({ cardOnFile: { status } }));
      expect(cardRow(), status).toBeNull();
    }
    cleanup();
    await open(detailFor({ cardOnFile: null, card: null }));
    expect(cardRow()).toBeNull();
    cleanup();
    await open(detailFor({ card: null }));
    expect(cardRow()).toBeNull();
  });

  it("not once the visit is checked out: there is no checkout left to inform", async () => {
    await open(detailFor({ status: "completed", checkedOutAt: "2026-11-18T15:00:00.000Z" }));
    expect(startCheckout()).toBeNull();
    expect(cardRow()).toBeNull();
  });
});
