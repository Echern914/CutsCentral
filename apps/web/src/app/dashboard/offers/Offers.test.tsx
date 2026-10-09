import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { OffersList } from "./actions";

/**
 * OFFERS & CODES on the dashboard.
 *
 *  - the preview says exactly what the client gets and pays, worked out by
 *    the same functions the booking charges with;
 *  - MIKEYG30 from a client's page is theirs alone, one use;
 *  - making it shows the code to share - ChairBack sends nothing;
 *  - two taps make one offer;
 *  - Pause keeps it, Delete only for an offer never used.
 */
const createOffer = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());
const deleteOffer = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  createOfferAction: createOffer,
  setOfferActiveAction: setActive,
  deleteOfferAction: deleteOffer,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/contactUri", () => ({ copyText: vi.fn(async () => true) }));

const { CreateOfferDialog } = await import("./CreateOfferDialog");
const { OffersManager } = await import("./OffersManager");

const services = [
  { id: "cut", name: "Haircut", price: 40 },
  { id: "beard", name: "Beard", price: 20 },
];
const staff = [
  { id: "mikey", name: "Mikey" },
  { id: "dee", name: "Dee" },
];

function dialog(over: Partial<Parameters<typeof CreateOfferDialog>[0]> = {}) {
  return render(
    <CreateOfferDialog
      open
      onClose={vi.fn()}
      onCreated={vi.fn()}
      services={services}
      staff={staff}
      allowedServiceIds={null}
      ownStaffId={null}
      timezone="America/New_York"
      {...over}
    />,
  );
}
const preview = () => (screen.getByTestId("offer-preview").textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  createOffer.mockReset();
  setActive.mockReset().mockResolvedValue({ ok: true });
  deleteOffer.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe("🔴 MIKEYG30 from Jordan's page", () => {
  it("the preview: Jordan gets a free Haircut with Mikey, pays $0, once - and nothing is sent", () => {
    dialog({ client: { id: "jordan", name: "Jordan Q" } });
    fireEvent.click(screen.getByRole("button", { name: "Mikey" }));
    fireEvent.change(screen.getByPlaceholderText("SPOOKY25"), { target: { value: "mikeyg30" } });
    const said = preview();
    expect(said).toContain("Jordan Q gets a free Haircut with Mikey.");
    expect(said).toContain("Haircut: $40 → pays $0");
    expect(said).toContain("One use.");
    expect(said).toContain("Only when you book it for Jordan Q.");
    expect(said).toContain("ChairBack sends nothing.");
    // The code's letters are only a name.
    expect(screen.getByText(/Saved as MIKEYG30\. Its letters don't change what it gives\./)).toBeTruthy();
  });

  it("sends exactly that offer, and shows the code to share - not a message sent", async () => {
    createOffer.mockResolvedValue({ ok: true, id: "o1", code: "MIKEYG30" });
    dialog({ client: { id: "jordan", name: "Jordan Q" } });
    fireEvent.click(screen.getByRole("button", { name: "Mikey" }));
    fireEvent.change(screen.getByPlaceholderText("SPOOKY25"), { target: { value: "mikeyg30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await waitFor(() => expect(createOffer).toHaveBeenCalledTimes(1));
    expect(createOffer.mock.calls[0]![0]).toEqual({
      code: "MIKEYG30",
      kind: "FREE_SERVICE",
      freeServiceId: "cut",
      staffIds: ["mikey"],
      clientId: "jordan",
      maxUses: 1,
      maxUsesPerClient: null,
      endsAt: null,
    });
    const made = await screen.findByTestId("offer-made");
    expect(made.textContent).toContain("MIKEYG30");
    expect(made.textContent).toContain("ChairBack doesn't send it. Share it with Jordan Q yourself.");
  });

  it("🔴 two taps make one offer", async () => {
    let finish: (v: unknown) => void = () => {};
    createOffer.mockReturnValue(new Promise((r) => (finish = r)));
    dialog({ client: { id: "jordan", name: "Jordan Q" } });
    const btn = screen.getByRole("button", { name: "Create offer" });
    act(() => {
      btn.click();
      btn.click();
    });
    expect(createOffer).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, id: "o1", code: "X1X1X1" }));
  });
});

describe("a public code", () => {
  it("$10 off Haircut and Beard, once per client, until a last day", async () => {
    createOffer.mockResolvedValue({ ok: true, id: "o2", code: "FALL10" });
    dialog();
    fireEvent.change(screen.getByPlaceholderText("10"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Haircut" }));
    fireEvent.click(screen.getByRole("button", { name: "Beard" }));
    fireEvent.change(screen.getByLabelText(/Last day for visits/), { target: { value: "2026-10-31" } });
    const said = preview();
    expect(said).toContain("Anyone with the code gets $10 off with any provider.");
    expect(said).toContain("Haircut: $40 → pays $30");
    expect(said).toContain("Beard: $20 → pays $10");
    expect(said).toContain("No limit in total, once per client.");
    expect(said).toContain("Good for visits through Sat, Oct 31.");
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    await waitFor(() => expect(createOffer).toHaveBeenCalledTimes(1));
    // Through Oct 31 in New York = visits starting before Nov 1, 00:00 EDT.
    expect(createOffer.mock.calls[0]![0]).toMatchObject({
      kind: "AMOUNT_OFF",
      amountOffCents: 1000,
      serviceIds: ["cut", "beard"],
      maxUses: null,
      maxUsesPerClient: 1,
      endsAt: "2026-11-01T04:00:00.000Z",
    });
  });

  it("an amount that can't be sent is said, and nothing is sent", async () => {
    dialog();
    fireEvent.click(screen.getByRole("button", { name: "Create offer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Say how many dollars it takes off.");
    expect(createOffer).not.toHaveBeenCalled();
  });

  it("a provider seat: only its permitted services, only its own self", () => {
    dialog({ allowedServiceIds: ["beard"], ownStaffId: "dee" });
    fireEvent.click(screen.getByRole("button", { name: "$ off" }));
    expect(screen.queryByRole("button", { name: "Haircut" })).toBeNull();
    expect(screen.getByRole("button", { name: "Beard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mikey" })).toBeNull();
  });
});

describe("the list", () => {
  const list = (over: Partial<OffersList["offers"][number]> = {}): OffersList => ({
    enabled: true,
    canCreate: true,
    allowedServiceIds: null,
    ownStaffId: null,
    timezone: "America/New_York",
    services,
    staff,
    offers: [
      {
        id: "o1",
        code: "MIKEYG30",
        kind: "FREE_SERVICE",
        amountOffCents: null,
        percentOffBps: null,
        freeServiceId: "cut",
        serviceIds: [],
        staffIds: ["mikey"],
        client: { id: "jordan", name: "Jordan Q" },
        maxUses: 1,
        maxUsesPerClient: null,
        endsAt: null,
        active: true,
        note: null,
        uses: 0,
        status: "on",
        createdAt: "2026-10-08T12:00:00.000Z",
        ...over,
      },
    ],
  });

  it("says what each gives, who it's for and how much is left", () => {
    render(<OffersManager list={list()} />);
    const row = within(screen.getByTestId("offers-list")).getByText("MIKEYG30").closest("li")!;
    expect(row.textContent).toContain("A free Haircut");
    expect(row.textContent).toContain("with Mikey");
    expect(row.textContent).toContain("Only Jordan Q · 0 of 1 used");
  });

  it("an unused offer can be deleted; a used one only paused", async () => {
    const { unmount } = render(<OffersManager list={list()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteOffer).toHaveBeenCalledWith("o1"));
    unmount();
    render(<OffersManager list={list({ uses: 1, status: "used_up" })} />);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith("o1", false));
  });
});
