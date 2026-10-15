import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KioskClient } from "./KioskClient";
import {
  kioskChallengeAction,
  kioskCheckInAction,
  kioskDeskWaitsAction,
  kioskEstimateAction,
  kioskResolveAction,
  kioskVerifyAction,
} from "./actions";

vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
vi.mock("./actions", () => ({
  kioskResolveAction: vi.fn(),
  kioskDeskWaitsAction: vi.fn(),
  kioskEstimateAction: vi.fn(),
  kioskChallengeAction: vi.fn(),
  kioskVerifyAction: vi.fn(),
  kioskCheckInAction: vi.fn(),
}));

/**
 * A TEAM FRONT DESK kiosk: after their name, the customer picks who they're
 * here for - each business with its wait, or "Next available" - and from then
 * on sees only that business's menu. The pick rides every call after it, and
 * a pick the server refuses sends them back to choose again.
 */
const menu = (prefix: string, service: string) => ({
  services: [{ id: `${prefix}-s1`, name: service, description: null, durationMin: 30, price: 40, color: null }],
  staff: [{ id: `${prefix}-b1`, name: `${prefix} chair`, imageUrl: null }],
  offerings: [{ serviceId: `${prefix}-s1`, staffId: `${prefix}-b1` }],
});

const deskData = {
  shop: { name: "United Barbershop", logoUrl: null, accentColor: null, timezone: "UTC" },
  acceptingNow: true,
  setupComplete: true,
  services: [],
  staff: [],
  offerings: [],
  desk: {
    businesses: [
      { id: "link-chris", name: "Chris Clipz", logoUrl: null, ...menu("chris", "Chris Fade") },
      { id: "link-jay", name: "Jay Blendz", logoUrl: null, ...menu("jay", "Jay Taper") },
      { id: "link-kim", name: "Kim Cuts", logoUrl: null, ...menu("kim", "Kim Trim") },
    ],
  },
  consent: { text: "Text me my place in line.", version: "v1" },
};

const ok = <T,>(data: T) => ({ ok: true, status: 200, data, error: undefined });
const resolveMock = vi.mocked(kioskResolveAction);
const waitsMock = vi.mocked(kioskDeskWaitsAction);
const estimateMock = vi.mocked(kioskEstimateAction);
const checkInMock = vi.mocked(kioskCheckInAction);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#k=test-kiosk-token-abcdefgh";
  resolveMock.mockResolvedValue(ok(deskData) as never);
  waitsMock.mockResolvedValue(
    ok({
      ok: true as const,
      businesses: [
        { id: "link-chris", waitMin: 25, ahead: 1 },
        { id: "link-jay", waitMin: 5, ahead: 0 },
        { id: "link-kim", waitMin: null, ahead: 0 },
      ],
    }) as never,
  );
  vi.mocked(kioskChallengeAction).mockResolvedValue(ok({ ok: true as const }) as never);
  vi.mocked(kioskVerifyAction).mockResolvedValue(
    ok({ ok: true as const, verified: true, proof: "proof-1", known: false, firstName: null }) as never,
  );
  estimateMock.mockResolvedValue(ok({ ok: true as const, waitMin: 5, ahead: 0 }) as never);
  checkInMock.mockResolvedValue(ok({ ok: true as const }) as never);
});

afterEach(() => {
  window.location.hash = "";
});

/** A business's own button in the list (not "Next available - …"). */
const list = () => document.querySelector<HTMLElement>('[data-qa="desk-businesses"]')!;
const biz = (name: string) => within(list()).getByRole("button", { name: new RegExp(name) });
const findBiz = async (name: string) => {
  await screen.findByText("Who are you here for?");
  return within(await waitFor(() => list())).findByRole("button", { name: new RegExp(name) });
};

/** Phone, code and name - to the "who are you here for" step. */
async function toWho() {
  render(<KioskClient />);
  fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
  fireEvent.change(screen.getByLabelText(/mobile number/i), { target: { value: "2125551234" } });
  fireEvent.click(screen.getByRole("button", { name: /text me a code/i }));
  fireEvent.change(await screen.findByLabelText(/verification code/i), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
  fireEvent.change(await screen.findByLabelText(/first name/i), { target: { value: "Dee" } });
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  await screen.findByText("Who are you here for?");
  await screen.findByText("About 25 min");
}

describe("the front desk", () => {
  it("shows each business with its wait; one with no room today can't be picked", async () => {
    await toWho();
    expect(biz("Chris Clipz").textContent).toContain("About 25 min");
    expect(biz("Jay Blendz").textContent).toContain("About 5 min");
    const kim = biz("Kim Cuts") as HTMLButtonElement;
    expect(kim.textContent).toContain("Not today");
    expect(kim.disabled).toBe(true);
  });

  it("'Next available' is the shortest wait", async () => {
    await toWho();
    const next = screen.getByRole("button", { name: /next available/i });
    expect(next.textContent).toBe("Next available - Jay Blendz");
    fireEvent.click(next);
    expect(await screen.findByText("With Jay Blendz")).toBeTruthy();
  });

  it("🔴 after the pick, only that business's menu - and the pick rides the estimate and the check-in", async () => {
    await toWho();
    fireEvent.click(biz("Chris Clipz"));
    expect(await screen.findByRole("button", { name: /Chris Fade/ })).toBeTruthy();
    expect(screen.queryByText("Jay Taper")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Chris Fade/ }));
    // One chair at Chris's business: no "anyone in particular" step.
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByText(/estimated wait about/i);
    expect(estimateMock).toHaveBeenCalledWith(
      expect.objectContaining({ serviceIds: ["chris-s1"], businessId: "link-chris" }),
    );
    expect(screen.getByText("With: Chris Clipz")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /join the line/i }));
    await screen.findByText(/you're in line/i);
    expect(checkInMock).toHaveBeenCalledWith(
      expect.objectContaining({ serviceIds: ["chris-s1"], businessId: "link-chris", preferredStaffId: null }),
    );
  });

  it("picking someone else clears what was chosen", async () => {
    await toWho();
    fireEvent.click(biz("Chris Clipz"));
    fireEvent.click(await screen.findByRole("button", { name: /Chris Fade/ }));
    fireEvent.click(screen.getByRole("button", { name: /pick someone else/i }));
    await screen.findByText("Who are you here for?");
    fireEvent.click(await findBiz("Jay Blendz"));
    const jayCut = await screen.findByRole("button", { name: /Jay Taper/ });
    expect(jayCut.getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("🔴 a pick the server refuses goes back to choosing - with the verified phone kept", async () => {
    checkInMock.mockResolvedValueOnce({ ok: false, status: 400, data: null, error: "invalid_selection" } as never);
    await toWho();
    fireEvent.click(biz("Jay Blendz"));
    fireEvent.click(await screen.findByRole("button", { name: /Jay Taper/ }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByText(/estimated wait about/i);
    fireEvent.click(screen.getByRole("button", { name: /join the line/i }));
    expect(await screen.findByText(/can't take walk-ins right now - please pick again/)).toBeTruthy();
    await screen.findByText("Who are you here for?");
    // No new code: the same proof goes with the next pick.
    expect(vi.mocked(kioskChallengeAction)).toHaveBeenCalledTimes(1);
    fireEvent.click(await findBiz("Chris Clipz"));
    fireEvent.click(await screen.findByRole("button", { name: /Chris Fade/ }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await screen.findByText(/estimated wait about/i);
    fireEvent.click(screen.getByRole("button", { name: /join the line/i }));
    await screen.findByText(/you're in line/i);
    expect(checkInMock).toHaveBeenLastCalledWith(expect.objectContaining({ proof: "proof-1", businessId: "link-chris" }));
  });

  it("no one able to take a walk-in: the desk says so, in words for both audiences", async () => {
    resolveMock.mockResolvedValue(ok({ ...deskData, setupComplete: false, desk: { businesses: [] } }) as never);
    render(<KioskClient />);
    expect(await screen.findByText(/No one is taking walk-ins here right now/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/each barber turns on front-desk walk-ins/)).toBeTruthy());
  });
});
