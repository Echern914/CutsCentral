import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Client-facing mishaps from the 2026-10-08 sweep:
 *
 *  - a typo'd email on the shop page's request form read "Something went
 *    wrong" on every try;
 *  - Android got an Apple App Store link from "Get the app";
 *  - Stop texts / Resume texts failed silently on the rewards page;
 *  - leaving the waitlist from the email said "You're off the list" when the
 *    request never got through;
 *  - hiding the last page section turned every section back on.
 */

const a = vi.hoisted(() => ({
  submitRequestAction: vi.fn(),
  optInAction: vi.fn(),
  optOutAction: vi.fn(),
  cancelWaitlistAction: vi.fn(),
}));
vi.mock("./s/[slug]/actions", () => ({ submitRequestAction: a.submitRequestAction }));
vi.mock("./r/[magicToken]/actions", () => ({ optInAction: a.optInAction, optOutAction: a.optOutAction }));
vi.mock("./waitlist/cancel/[token]/actions", () => ({ cancelWaitlistAction: a.cancelWaitlistAction }));

const { RequestForm } = await import("./s/[slug]/RequestForm");
const { GetTheApp } = await import("./r/[magicToken]/GetTheApp");
const { ConsentCard } = await import("./r/[magicToken]/ConsentCard");
const { CancelWaitlist } = await import("./waitlist/cancel/[token]/CancelWaitlist");
const { SectionOrderEditor } = await import("./dashboard/site/SectionOrderEditor");

const theme = {
  bg: "#000",
  surface: "#111",
  border: "#222",
  text: "#fff",
  muted: "#999",
  accent: "#c8a24a",
  onAccent: "#000",
  scheme: "dark",
  radius: "16px",
  buttonRadius: "999px",
} as never;

const UA = (ua: string) => Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
const REAL_UA = navigator.userAgent;

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  localStorage.clear();
});
afterEach(() => UA(REAL_UA));

describe("the shop page's request form", () => {
  it("🔴 a typo'd email is named, and nothing is sent", () => {
    render(<RequestForm slug="dees" shopName="Dee's" accent="#c8a24a" theme={theme} />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@gmail" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByText(/That email doesn't look right/)).toBeTruthy();
    expect(a.submitRequestAction).not.toHaveBeenCalled();
  });
});

describe("Get the app on the rewards page", () => {
  it("an iPhone sees the App Store link (the banner works at all)", async () => {
    UA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
    const { container } = render(
      <GetTheApp shopName="Dee's" theme={theme} appStoreUrl="https://apps.apple.com/app/id1" playStoreUrl={null} />,
    );
    await waitFor(() => expect(container.innerHTML).toContain("apps.apple.com"));
  });

  it("🔴 Android with no Play Store link sees no Apple link", async () => {
    UA("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36");
    const { container } = render(
      <GetTheApp shopName="Dee's" theme={theme} appStoreUrl="https://apps.apple.com/app/id1" playStoreUrl={null} />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).not.toContain("apps.apple.com");
  });
});

describe("text consent on the rewards page", () => {
  it("🔴 a failed Stop texts says so", async () => {
    a.optOutAction.mockResolvedValue({ ok: false });
    render(<ConsentCard magicToken="t" shopName="Dee's" theme={theme} initialState="opted_in" initialHasPhone />);
    fireEvent.click(screen.getByRole("button", { name: "Stop texts" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/went wrong/);
  });

  it("opted out with no phone shows the card with a number box, not a dead Resume", () => {
    render(<ConsentCard magicToken="t" shopName="Dee's" theme={theme} initialState="opted_out" initialHasPhone={false} />);
    expect(screen.getByLabelText("Your mobile number")).toBeTruthy();
  });
});

describe("leaving the waitlist from the email", () => {
  it("🔴 a request that never got through says they're still on it", async () => {
    a.cancelWaitlistAction.mockResolvedValue({ ok: false });
    render(<CancelWaitlist token="tok" />);
    fireEvent.click(screen.getByRole("button", { name: "Take me off the list" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still on the list/);
    expect(screen.queryByText(/You.re off the list/)).toBeNull();
  });

  it("one that did says they're off", async () => {
    a.cancelWaitlistAction.mockResolvedValue({ ok: true });
    render(<CancelWaitlist token="tok" />);
    fireEvent.click(screen.getByRole("button", { name: "Take me off the list" }));
    await waitFor(() => expect(screen.getByText(/You.re off the list/)).toBeTruthy());
  });
});

describe("page sections", () => {
  it("🔴 the last visible section can't be switched off (empty means 'show all')", () => {
    const onChange = vi.fn();
    render(<SectionOrderEditor value={["gallery"] as never} onChange={onChange} />);
    // The one switched-on switch is Gallery's; switching it off would store [].
    const on = screen.getAllByRole("switch").filter((s) => s.getAttribute("aria-checked") === "true");
    expect(on).toHaveLength(1);
    fireEvent.click(on[0]!);
    expect(onChange).not.toHaveBeenCalled();
  });
});
