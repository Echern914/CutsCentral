import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KioskClient } from "./KioskClient";
import {
  kioskChallengeAction,
  kioskCheckInAction,
  kioskEstimateAction,
  kioskResolveAction,
  kioskVerifyAction,
} from "./actions";

vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
vi.mock("./actions", () => ({
  kioskResolveAction: vi.fn(),
  kioskEstimateAction: vi.fn(),
  kioskChallengeAction: vi.fn(),
  kioskVerifyAction: vi.fn(),
  kioskCheckInAction: vi.fn(),
}));

/**
 * The shared-device promises, from the rendered side: a completed check-in
 * wipes EVERYTHING for the next customer, nothing a customer types is ever
 * persisted, and a double tap cannot double submit.
 */

const shopData = {
  shop: { name: "Fade Lab", logoUrl: null, accentColor: null, timezone: "UTC" },
  acceptingNow: true,
  services: [
    { id: "s1", name: "Fade", description: null, durationMin: 30, price: 40, color: null },
    { id: "s2", name: "Beard", description: null, durationMin: 15, price: 20, color: null },
  ],
  staff: [{ id: "b1", name: "Ava", imageUrl: null }],
  offerings: [
    { serviceId: "s1", staffId: "b1" },
    { serviceId: "s2", staffId: "b1" },
  ],
  consent: { text: "Text me my place in line.", version: "v1" },
};

const resolveMock = vi.mocked(kioskResolveAction);
const challengeMock = vi.mocked(kioskChallengeAction);
const verifyMock = vi.mocked(kioskVerifyAction);
const estimateMock = vi.mocked(kioskEstimateAction);
const checkInMock = vi.mocked(kioskCheckInAction);

const ok = <T,>(data: T) => ({ ok: true, status: 200, data, error: undefined });

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#k=test-kiosk-token-abcdefgh";
  localStorage.clear();
  sessionStorage.clear();
  resolveMock.mockResolvedValue(ok(shopData) as never);
  challengeMock.mockResolvedValue(ok({ ok: true as const }) as never);
  verifyMock.mockResolvedValue(
    ok({ ok: true as const, verified: true, proof: "proof-1", known: false, firstName: null }) as never,
  );
  estimateMock.mockResolvedValue(ok({ ok: true as const, waitMin: 25, ahead: 2 }) as never);
  checkInMock.mockResolvedValue(ok({ ok: true as const }) as never);
});

afterEach(() => {
  window.location.hash = "";
});

/** Drive one customer through the whole flow to the success screen. */
async function driveToDone() {
  render(<KioskClient />);
  fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
  fireEvent.change(screen.getByLabelText(/mobile number/i), {
    target: { value: "2125551234" },
  });
  fireEvent.click(screen.getByRole("button", { name: /text me a code/i }));
  fireEvent.change(await screen.findByLabelText(/verification code/i), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
  fireEvent.change(await screen.findByLabelText(/first name/i), {
    target: { value: "Marcus" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Fade/ }));
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  fireEvent.click(await screen.findByRole("button", { name: /next available/i }));
  fireEvent.click(screen.getByRole("button", { name: /see my wait/i }));
  await screen.findByText(/estimated wait about/i);
  fireEvent.click(screen.getByRole("button", { name: /join the line/i }));
  await screen.findByText(/you're in line/i);
}

describe("the happy flow", () => {
  it("walks welcome -> done, showing the server's estimate as an estimate", async () => {
    await driveToDone();
    expect(checkInMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "2125551234",
        firstName: "Marcus",
        serviceIds: ["s1"],
        preferredStaffId: null,
      }),
    );
    // The wording never promises: "estimates change" copy was on review.
    expect(challengeMock).toHaveBeenCalledTimes(1);
  });

  it("tapping Done wipes every field for the next customer", async () => {
    await driveToDone();
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    // Back on welcome...
    fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
    // ...and the phone field is EMPTY - nothing of Marcus survives.
    expect(
      (screen.getByLabelText(/mobile number/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("persists NOTHING: no localStorage, no sessionStorage, ever", async () => {
    await driveToDone();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("inputs opt out of autofill on a shared device", async () => {
    await driveToDone();
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
    const phone = screen.getByLabelText(/mobile number/i);
    expect(phone.getAttribute("autocomplete")).toBe("off");
  });
});

describe("refusals stay honest and generic", () => {
  it("a wrong code shows one retry line and clears the input", async () => {
    verifyMock.mockResolvedValueOnce(
      ok({ ok: true as const, verified: false }) as never,
    );
    render(<KioskClient />);
    fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
    fireEvent.change(screen.getByLabelText(/mobile number/i), {
      target: { value: "2125551234" },
    });
    fireEvent.click(screen.getByRole("button", { name: /text me a code/i }));
    fireEvent.change(await screen.findByLabelText(/verification code/i), {
      target: { value: "999999" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't work/i);
    expect(
      (screen.getByLabelText(/verification code/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("a dead kiosk link shows the front-desk card, not a broken app", async () => {
    window.location.hash = "";
    render(<KioskClient />);
    expect(await screen.findByText(/isn't set up/i)).toBeTruthy();
  });

  it("a not-accepting shop shows the paused screen", async () => {
    resolveMock.mockResolvedValue(
      ok({ ...shopData, acceptingNow: false }) as never,
    );
    render(<KioskClient />);
    expect(await screen.findByText(/paused right now/i)).toBeTruthy();
  });

  it("an API failure offers retry and never fakes a success", async () => {
    checkInMock.mockResolvedValueOnce({
      ok: false,
      status: 0,
      data: null,
      error: "network_error",
    } as never);
    await (async () => {
      render(<KioskClient />);
      fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
      fireEvent.change(screen.getByLabelText(/mobile number/i), {
        target: { value: "2125551234" },
      });
      fireEvent.click(screen.getByRole("button", { name: /text me a code/i }));
      fireEvent.change(await screen.findByLabelText(/verification code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
      fireEvent.change(await screen.findByLabelText(/first name/i), {
        target: { value: "M" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Fade/ }));
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /next available/i }));
      fireEvent.click(screen.getByRole("button", { name: /see my wait/i }));
      await screen.findByText(/estimated wait about/i);
      fireEvent.click(screen.getByRole("button", { name: /join the line/i }));
    })();
    expect(await screen.findByText(/couldn't reach the shop/i)).toBeTruthy();
    expect(screen.queryByText(/you're in line/i)).toBeNull();
  });
});

describe("idle + double-submit", () => {
  it("mid-flow inactivity wipes the customer and returns to welcome", async () => {
    vi.useFakeTimers();
    try {
      render(<KioskClient />);
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.change(screen.getByLabelText(/mobile number/i), {
        target: { value: "2125551234" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(91_000);
      });
      // Back at welcome, and the number is gone.
      expect(screen.getByRole("button", { name: /check in/i })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      expect(
        (screen.getByLabelText(/mobile number/i) as HTMLInputElement).value,
      ).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the submit button guards against a double tap", async () => {
    let resolveCheckIn: (v: unknown) => void = () => {};
    checkInMock.mockImplementationOnce(
      () => new Promise((r) => (resolveCheckIn = r)) as never,
    );
    await (async () => {
      render(<KioskClient />);
      fireEvent.click(await screen.findByRole("button", { name: /check in/i }));
      fireEvent.change(screen.getByLabelText(/mobile number/i), {
        target: { value: "2125551234" },
      });
      fireEvent.click(screen.getByRole("button", { name: /text me a code/i }));
      fireEvent.change(await screen.findByLabelText(/verification code/i), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
      fireEvent.change(await screen.findByLabelText(/first name/i), {
        target: { value: "M" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Fade/ }));
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /next available/i }));
      fireEvent.click(screen.getByRole("button", { name: /see my wait/i }));
      await screen.findByText(/estimated wait about/i);
      const join = screen.getByRole("button", { name: /join the line/i });
      fireEvent.click(join);
      fireEvent.click(join);
      fireEvent.click(join);
    })();
    resolveCheckIn(ok({ ok: true }));
    await screen.findByText(/you're in line/i);
    expect(checkInMock).toHaveBeenCalledTimes(1);
  });
});
