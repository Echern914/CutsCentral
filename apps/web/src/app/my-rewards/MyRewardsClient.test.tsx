import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MyRewardsClient } from "./MyRewardsClient";

/**
 * The recovery page's copy discipline: it never claims to know whether a
 * number exists, and only branches AFTER the customer proved possession.
 */

const challenge = vi.fn();
const verify = vi.fn();
const shopsFn = vi.fn();
const select = vi.fn();

vi.mock("./actions", () => ({
  recoveryChallengeAction: (...a: unknown[]) => challenge(...a),
  recoveryVerifyAction: (...a: unknown[]) => verify(...a),
  recoveryShopsAction: (...a: unknown[]) => shopsFn(...a),
  recoverySelectAction: (...a: unknown[]) => select(...a),
}));

const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null });

beforeEach(() => {
  vi.resetAllMocks();
});

async function toCodeStep() {
  challenge.mockResolvedValue(ok({ ok: true }) as never);
  render(<MyRewardsClient />);
  fireEvent.change(screen.getByPlaceholderText(/555/), {
    target: { value: "212 555 0134" },
  });
  fireEvent.click(screen.getByText(/text me a code/i));
  await screen.findByText(/if that number's on file/i);
}

describe("MyRewardsClient", () => {
  it("the code step never asserts the number exists - 'if on file' copy", async () => {
    await toCodeStep();
    expect(screen.getByText(/if that number's on file/i)).toBeTruthy();
  });

  it("a failed verify is one generic message - wrong and never-sent look identical", async () => {
    await toCodeStep();
    verify.mockResolvedValue(ok({ verified: false }) as never);
    fireEvent.change(screen.getByPlaceholderText("••••••"), { target: { value: "000000" } });
    fireEvent.click(screen.getByText(/^verify$/i));
    expect(await screen.findByText(/that code didn't work/i)).toBeTruthy();
  });

  it("verified -> chooser -> select navigates to the chosen shop's rewards", async () => {
    await toCodeStep();
    verify.mockResolvedValue(ok({ verified: true, proof: "p".repeat(24) }) as never);
    shopsFn.mockResolvedValue(
      ok({
        shops: [
          { selectionId: "a".repeat(32), name: "Alpha Cuts", logoUrl: null, industry: "barber", city: "Albany", region: "NY" },
        ],
      }) as never,
    );
    select.mockResolvedValue(ok({ ok: true, url: "https://app.test/r/tok123/rewards" }) as never);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign },
      writable: true,
    });

    fireEvent.change(screen.getByPlaceholderText("••••••"), { target: { value: "424242" } });
    fireEvent.click(screen.getByText(/^verify$/i));
    fireEvent.click(await screen.findByText(/alpha cuts/i));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://app.test/r/tok123/rewards"));
  });

  it("a verified phone with NO shops gets the one honest empty state", async () => {
    await toCodeStep();
    verify.mockResolvedValue(ok({ verified: true, proof: "p".repeat(24) }) as never);
    shopsFn.mockResolvedValue(ok({ shops: [] }) as never);
    fireEvent.change(screen.getByPlaceholderText("••••••"), { target: { value: "424242" } });
    fireEvent.click(screen.getByText(/^verify$/i));
    expect(await screen.findByText(/couldn't find rewards for this number/i)).toBeTruthy();
  });
});
