import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The payment step, which had no test at all while carrying the only code in
 * the product that moves a customer's money.
 *
 * 🔴 THE DEFECT THIS PINS. `confirmPayment` returning `processing` was treated
 * as a completed booking, so the parent flipped straight to "You're booked!".
 * But the appointment is only a HOLD until `payment_intent.succeeded` reaches
 * the webhook — a `processing` intent that later fails leaves the customer
 * holding a confirmation page for an appointment the 5-minute sweep has
 * already cancelled, with no notification of any kind. `onPaid` now means
 * "the money is away, go and ask the server", and the parent decides.
 */

const confirmPayment = vi.hoisted(() => vi.fn());
const elementProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => ({})) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Capture the props so the test can assert what we asked Stripe for, and
  // fire onReady the way the real Element does once its iframe mounts.
  PaymentElement: (props: Record<string, unknown>) => {
    elementProps.current = props;
    return (
      <button type="button" data-testid="element-ready" onClick={() => (props.onReady as () => void)()}>
        card fields
      </button>
    );
  },
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

// STRIPE_CONFIGURED is read at module load, so the key has to be in place
// BEFORE the import - the same way the real build inlines it.
vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_fixture");
const { PaymentStep } = await import("./PaymentStep");

function mount(onPaid = vi.fn()) {
  render(
    <PaymentStep
      clientSecret="pi_secret_123"
      amountLabel="$20"
      accent="#c8a24a"
      returnUrl="https://example.test/book/manage/tok_123"
      onPaid={onPaid}
    />,
  );
  // The Element mounts asynchronously; the button stays disabled until it does.
  fireEvent.click(screen.getByTestId("element-ready"));
  return { onPaid, button: screen.getByRole("button", { name: "Pay $20" }) };
}

beforeEach(() => {
  confirmPayment.mockReset();
  elementProps.current = null;
});

describe("PaymentStep", () => {
  it("🔴 does NOT report a booking on `processing` - it hands off to the parent", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
    const { onPaid, button } = mount();
    fireEvent.click(button);
    // Same call as `succeeded`: the component's job is "the money is away".
    // What it must never do is decide the appointment is confirmed.
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/booked/i)).toBeNull();
  });

  it("hands off on a plain success too", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    const { onPaid, button } = mount();
    fireEvent.click(button);
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
  });

  it("🔴 always passes a return_url, so a redirect method is not a dead end", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    const { button } = mount();
    fireEvent.click(button);
    await waitFor(() => expect(confirmPayment).toHaveBeenCalled());
    expect(confirmPayment.mock.calls[0]![0]).toMatchObject({
      redirect: "if_required",
      confirmParams: { return_url: "https://example.test/book/manage/tok_123" },
    });
  });

  it("shows Stripe's own message on a decline and lets them try again", async () => {
    confirmPayment.mockResolvedValue({ error: { message: "Your card was declined." } });
    const { onPaid, button } = mount();
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(onPaid).not.toHaveBeenCalled();
    // Re-enabled: a declined card is very often followed by a second one.
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay $20" })).toBeEnabled());
  });

  it("does not claim success for a status that is neither", async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: "requires_payment_method" } });
    const { onPaid, button } = mount();
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment didn't complete");
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("the pay button is dead until the Element has actually mounted", () => {
    render(
      <PaymentStep
        clientSecret="pi_secret_123"
        amountLabel="$20"
        accent="#c8a24a"
        returnUrl="https://example.test/back"
        onPaid={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Pay $20" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading secure payment");
  });

  it("lets the Element choose the wallets - we never hand-write the list", () => {
    mount();
    // Apple Pay / Google Pay / Link come from the intent's
    // automatic_payment_methods plus the registered domain. A hard-coded
    // wallet list here would be a second source of truth that silently
    // disagrees with what the device can actually pay with.
    expect(elementProps.current).toMatchObject({ options: { layout: "tabs" } });
    expect(JSON.stringify(elementProps.current?.options)).not.toContain("applePay");
  });
});

describe("when the deployment has no Stripe key", () => {
  it("says so, instead of a live-looking button that does nothing", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
    // Re-import under the empty key; the module-level constant is recomputed.
    const { PaymentStep: Fresh } = await import("./PaymentStep");
    render(
      <Fresh
        clientSecret="pi_secret_123"
        amountLabel="$20"
        accent="#c8a24a"
        returnUrl="https://example.test/back"
        onPaid={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Card payment isn’t available");
    // And it says the one thing a customer needs to know about their money.
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing has been charged");
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
    vi.unstubAllEnvs();
  });
});
