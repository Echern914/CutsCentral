import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * "Before you continue": the Terms + Privacy screen the dashboard shows in
 * place of itself, and the decision of whether it shows at all.
 *
 * What must hold: the box starts unticked and the button does nothing until it
 * is ticked; agreeing posts once and re-renders the layout; a failed save says
 * so and leaves them on the screen; and the decision only ever shows the gate
 * on a definite "required" - a failed read, an older API, or a demo session
 * all show the dashboard (fail open).
 */

const acceptTermsAction = vi.hoisted(() => vi.fn());
vi.mock("./termsActions", () => ({ acceptTermsAction }));
vi.mock("@/app/(auth)/actions", () => ({ logoutAction: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiGet }));

const { TermsGate } = await import("./TermsGate");
const { getTermsStatus, termsGateShows } = await import("@/lib/terms");

beforeEach(() => {
  acceptTermsAction.mockReset();
  refresh.mockReset();
  apiGet.mockReset();
});

const box = () => screen.getByRole("checkbox");
const agree = () => screen.getByRole("button", { name: /agree and continue/i });

describe("the screen", () => {
  it("starts unticked, with the button disabled until the box is ticked", () => {
    render(<TermsGate previouslyAgreed={false} />);
    expect(screen.getByRole("heading", { name: "Before you continue" })).toBeTruthy();
    expect((box() as HTMLInputElement).checked).toBe(false);
    expect((agree() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(agree());
    expect(acceptTermsAction).not.toHaveBeenCalled();
    fireEvent.click(box());
    expect((agree() as HTMLButtonElement).disabled).toBe(false);
  });

  it("says what it asks, links the documents in a new tab, and offers a way out", () => {
    render(<TermsGate previouslyAgreed={false} />);
    const label = box().closest("label")!;
    expect(label.textContent).toContain("I agree to the Terms of Service and Privacy Policy");
    expect(label.textContent).toContain("not financial, tax or accounting advice");
    expect(label.textContent).toContain("figures are estimates that may not be accurate");
    for (const [name, href] of [
      ["Terms of Service", "/terms"],
      ["Privacy Policy", "/privacy"],
      ["SMS Messaging Policy", "/sms"],
    ] as const) {
      const a = screen.getByRole("link", { name });
      expect(a.getAttribute("href")).toBe(href);
      expect(a.getAttribute("target")).toBe("_blank");
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("an earlier agreement is told the Terms changed", () => {
    render(<TermsGate previouslyAgreed />);
    expect(screen.getByText(/We've updated our Terms of Service and Privacy Policy/)).toBeTruthy();
  });

  it("agreeing posts once and re-renders the layout", async () => {
    acceptTermsAction.mockResolvedValue({ ok: true });
    render(<TermsGate previouslyAgreed={false} />);
    fireEvent.click(box());
    const button = agree();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(acceptTermsAction).toHaveBeenCalledTimes(1);
  });

  it("a failed save says so and stays on the screen", async () => {
    acceptTermsAction.mockResolvedValue({ ok: false });
    render(<TermsGate previouslyAgreed={false} />);
    fireEvent.click(box());
    fireEvent.click(agree());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("whether the gate shows", () => {
  const status = (required: boolean, acceptedVersion: string | null = null) => ({
    required,
    currentVersion: "2026-10-27",
    acceptedVersion,
  });

  it("🔴 the API says required (stale or missing version): the gate", () => {
    expect(termsGateShows(status(true, "2026-06-12"), { demo: false })).toBe(true);
    expect(termsGateShows(status(true, null), { demo: false })).toBe(true);
  });

  it("current agreement: the dashboard", () => {
    expect(termsGateShows(status(false, "2026-10-27"), { demo: false })).toBe(false);
  });

  it("the read-only demo never sees it", () => {
    expect(termsGateShows(status(true), { demo: true })).toBe(false);
  });

  it("🔴 FAIL OPEN: a failed read shows the dashboard", async () => {
    apiGet.mockResolvedValueOnce({ ok: false, status: 0, data: null, error: "network_error" });
    const s1 = await getTermsStatus();
    expect(s1).toBeNull();
    expect(termsGateShows(s1, { demo: false })).toBe(false);

    apiGet.mockRejectedValueOnce(new Error("boom"));
    expect(await getTermsStatus()).toBeNull();

    // An older API without the route.
    apiGet.mockResolvedValueOnce({ ok: false, status: 404, data: null });
    expect(await getTermsStatus()).toBeNull();

    // A malformed answer.
    apiGet.mockResolvedValueOnce({ ok: true, status: 200, data: { required: "yes" } });
    expect(await getTermsStatus()).toBeNull();
  });

  it("a good answer comes through as-is", async () => {
    apiGet.mockResolvedValueOnce({ ok: true, status: 200, data: status(true, "2026-06-12") });
    const s = await getTermsStatus();
    expect(s).toEqual(status(true, "2026-06-12"));
    expect(termsGateShows(s, { demo: false })).toBe(true);
  });
});
