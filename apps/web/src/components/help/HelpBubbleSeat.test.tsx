import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { setupBrief, type OnboardingFacts } from "@chairback/config/onboarding";

/**
 * The corner Assistant answers as the person asking, about their own shop.
 *
 * It used to answer everyone as the owner, from the general corpus only: an
 * owner half way through setup asking "how do I finish setting up?" got four
 * generic steps, some already done. The dashboard and setup layouts now hand
 * over the seat and the shop's setup brief (helpSeat.tsx).
 */
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { HelpBubble } = await import("./HelpBubble");
const { HelpSeatSync } = await import("./helpSeat");

const facts: OnboardingFacts = {
  hasShop: true,
  bookingMode: "native",
  bookingUrl: null,
  integrationConnected: false,
  staffCount: 1,
  serviceCount: 0,
  staffWithHours: 0,
  clientCount: 0,
};

async function ask(q: string) {
  fireEvent.click(screen.getByRole("button", { name: "Open the assistant" }));
  fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: q } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  });
}

describe("the corner Assistant, mid-setup", () => {
  it("🔴 answers 'finish setting up' with what this shop has left, each a button to it", async () => {
    render(
      <>
        <HelpSeatSync role="OWNER" setup={setupBrief(facts)} />
        <HelpBubble />
      </>,
    );
    await ask("how do I finish setting up");
    expect(screen.getByText(/2 steps left before clients can book you/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add your services/ }));
    expect(push).toHaveBeenCalledWith("/onboarding/services");
  });

  it("with no seat handed over (a marketing page), the written answer stands", async () => {
    render(<HelpBubble />);
    await ask("how do I finish setting up");
    expect(screen.queryByText(/steps left before clients can book you/)).toBeNull();
  });
});
