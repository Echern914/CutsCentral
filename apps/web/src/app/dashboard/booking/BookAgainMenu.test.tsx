import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";
import { REBOOK_EVENT } from "./rebookEvent";

/**
 * "Book again" in an appointment's More menu. It hands the calendar WHO and
 * WHAT (the client, the service, the provider) and closes the sheet - it never
 * writes anything itself, and it is only offered where it can work: a
 * ChairBack booking with a client, on a calendar whose booking form is there
 * to answer it.
 */
const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "completed",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Marcus Reed",
    serviceName: "Fade",
    staffName: "Dee",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:30:00.000Z",
    durationMin: 30,
    timezone: "America/New_York",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: { state: "unpaid" },
    checkedOutAt: null,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
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
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "completed",
};

async function openMore(detail: AppointmentDetail, canBookAgain: boolean, onClose = vi.fn()) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(
    <AppointmentSheet row={row} toast={vi.fn()} onClose={onClose} onChanged={vi.fn()} canBookAgain={canBookAgain} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "More" }, { timeout: 5000 }));
  return { menu: await screen.findByRole("menu", undefined, { timeout: 5000 }), onClose };
}

beforeEach(() => {
  getDetail.mockReset();
});

describe("Book again in the More menu", () => {
  it("🔴 hands over the client, service and provider - and closes the sheet, writing nothing", async () => {
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(REBOOK_EVENT, listen);
    try {
      const { menu, onClose } = await openMore(detailFor(), true);
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Book again/ }));
      expect(heard).toEqual([
        {
          clientId: "cl1",
          clientLabel: "Marcus Reed",
          serviceId: "svc1",
          serviceName: "Fade",
          staffId: "stf1",
          staffName: "Dee",
        },
      ]);
      expect(onClose).toHaveBeenCalled();
    } finally {
      window.removeEventListener(REBOOK_EVENT, listen);
    }
  });

  it("is not offered where no booking form would answer it", async () => {
    const { menu } = await openMore(detailFor(), false);
    expect(within(menu).queryByRole("menuitem", { name: /Book again/ })).toBeNull();
  });

  it("is not offered on an Acuity booking - that visit is booked in Acuity", async () => {
    const { menu } = await openMore(detailFor({ origin: "external", originLabel: "Acuity" }), true);
    expect(within(menu).queryByRole("menuitem", { name: /Book again/ })).toBeNull();
  });

  it("is not offered without a client to book for", async () => {
    const { menu } = await openMore(detailFor({ clientId: null }), true);
    expect(within(menu).queryByRole("menuitem", { name: /Book again/ })).toBeNull();
  });
});
