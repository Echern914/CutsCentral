import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * Signup's Terms + Privacy clickwrap. The box starts unticked, Create account
 * stays disabled until it is ticked, and the server action refuses (without
 * calling the API) when the form arrives without it - a tampered form gets
 * no further than the API, which refuses it as well (terms_required).
 */

vi.mock("next/headers", () => ({
  cookies: () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: () => new Map(),
}));
vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test", clientIpHeaders: () => ({}) }));
vi.mock("@/lib/sessionCookieDomain", () => ({ sessionCookieDomain: () => null }));
vi.mock("@/lib/activeShopCookie", () => ({ clearActiveShopCookie: vi.fn() }));
vi.mock("@/lib/teamLinkCookie", () => ({ clearTeamLinkCookie: vi.fn() }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
// useFormState / useFormStatus ship in Next's React build, not the plain one
// the tests run: stand in for them (the action has its own tests below).
vi.mock("react-dom", async () => {
  const real = await vi.importActual<typeof import("react-dom")>("react-dom");
  return {
    ...real,
    useFormState: (_action: unknown, initial: unknown) => [initial, vi.fn()],
    useFormStatus: () => ({ pending: false }),
  };
});
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

const { signupAction } = await import("./actions");
const { AuthForm } = await import("./AuthForm");

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response("{}", { status: 201, headers: { "set-cookie": "cb_session=abc; Path=/" } }),
);

beforeEach(() => {
  redirect.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

function form(extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("name", "Luigi");
  f.set("email", "luigi@test.local");
  f.set("password", "supersecret123");
  f.set("smsAttested", "on");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

describe("the signup form", () => {
  it("🔴 Create account is disabled until the Terms box is ticked", () => {
    render(
      <AuthForm mode="signup" action={vi.fn(async () => ({}))} googleAvailable={false} googleStartUrl="/g" />,
    );
    const terms = screen.getByRole("checkbox", { name: /I agree to the Terms of Service/ }) as HTMLInputElement;
    const create = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
    expect(terms.checked).toBe(false);
    expect(terms.required).toBe(true);
    expect(terms.name).toBe("acceptTerms");
    expect(create.disabled).toBe(true);
    fireEvent.click(terms);
    expect(create.disabled).toBe(false);
    fireEvent.click(terms);
    expect(create.disabled).toBe(true);
  });

  it("names the documents (new tab) and the not-financial-advice line", () => {
    render(
      <AuthForm mode="signup" action={vi.fn(async () => ({}))} googleAvailable={false} googleStartUrl="/g" />,
    );
    const label = screen.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).closest("label")!;
    expect(label.textContent).toBe(
      "I agree to the Terms of Service and Privacy Policy (including the SMS Messaging Policy). " +
        "I understand ChairBack is a business tool, not financial, tax or accounting advice, and that its " +
        "figures are estimates that may not be accurate.",
    );
    for (const a of Array.from(label.querySelectorAll("a"))) expect(a.getAttribute("target")).toBe("_blank");
  });

  it("sign-in shows no Terms box", () => {
    render(<AuthForm mode="login" action={vi.fn(async () => ({}))} googleAvailable={false} googleStartUrl="/g" />);
    expect(screen.queryByRole("checkbox", { name: /I agree to the Terms/ })).toBeNull();
  });
});

describe("the signup action", () => {
  it("🔴 without the tick: refused here, and the API is never called", async () => {
    const res = await signupAction({}, form());
    expect(res.error).toMatch(/agree to the Terms of Service and Privacy Policy/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("with the tick: acceptTerms: true goes to the API", async () => {
    await signupAction({}, form({ acceptTerms: "on" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.acceptTerms).toBe(true);
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("the API's terms_required becomes the same plain sentence", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "terms_required" }), { status: 400 }));
    const res = await signupAction({}, form({ acceptTerms: "on" }));
    expect(res.error).toMatch(/agree to the Terms of Service and Privacy Policy/);
  });
});
