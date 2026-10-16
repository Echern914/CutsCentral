import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * First-time setup's steps (web /onboarding/*).
 *
 *  - every write goes once, however fast the taps;
 *  - Continue goes where the step's own data says is next;
 *  - nothing is asked twice: names already on a chair, services already on
 *    the menu, and the owner's own name from signup are all carried in;
 *  - the starter service list starts unticked - a template becomes a service
 *    only when the owner ticks it;
 *  - reaching the finish finishes setup, once.
 */
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, replace: vi.fn() }) }));

const bookOnChairBack = vi.hoisted(() => vi.fn());
const keepOwnLink = vi.hoisted(() => vi.fn());
const addTeam = vi.hoisted(() => vi.fn());
const finishSetup = vi.hoisted(() => vi.fn());
vi.mock("./stepActions", () => ({
  bookOnChairBackAction: bookOnChairBack,
  keepOwnLinkAction: keepOwnLink,
  addTeamAction: addTeam,
  finishSetupAction: finishSetup,
  skipSetupAction: vi.fn(),
}));
const bulk = vi.hoisted(() => vi.fn());
vi.mock("@/app/dashboard/booking/actions", () => ({ createServicesBulkAction: bulk }));
// The hours sheet is the Calendar's own, tested there: here, only that it opens.
vi.mock("@/app/dashboard/booking/BookingManager", () => ({
  StaffHoursSheet: ({ staffName, onClose }: { staffName: string; onClose: () => void }) => (
    <div role="dialog" aria-label={`${staffName} hours`}>
      <button onClick={onClose}>Close hours</button>
    </div>
  ),
}));
vi.mock("@/components/VocabProvider", () => ({ useVocab: () => ({ serviceNoun: "service" }), cap: (w: string) => w }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { BookingChoice } = await import("./booking/BookingChoice");
const { TeamStep } = await import("./team/TeamStep");
const { ServicesStep } = await import("./services/ServicesStep");
const { HoursStep } = await import("./hours/HoursStep");
const { FinishSetup } = await import("./done/FinishSetup");

beforeEach(() => {
  for (const m of [push, refresh, bookOnChairBack, keepOwnLink, addTeam, finishSetup, bulk]) m.mockReset();
});

describe("how clients book", () => {
  const show = (connected: "Acuity" | "Square" | null = null) =>
    render(
      <BookingChoice
        acuityHref="https://api.test/api/acuity/oauth/start"
        squareHref={null}
        connected={connected}
        nextIfNative="/onboarding/team"
        nextIfLink="/onboarding/clients"
        continueHref="/onboarding/clients"
      />,
    );

  it("🔴 ChairBack booking: saved once however fast the taps, then on to the team", async () => {
    let answer!: (v: unknown) => void;
    bookOnChairBack.mockReturnValue(new Promise((r) => (answer = r)));
    show();
    const btn = screen.getByRole("button", { name: /Clients book me on ChairBack/ });
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(bookOnChairBack).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true }));
    expect(push).toHaveBeenCalledWith("/onboarding/team");
  });

  it("their own link: saved, then on to clients; a refusal stays on screen", async () => {
    keepOwnLink.mockResolvedValueOnce({ ok: false, error: "Paste the full link, starting with https://" });
    keepOwnLink.mockResolvedValueOnce({ ok: true });
    show();
    fireEvent.click(screen.getByRole("button", { name: /Keep my own booking link/ }));
    fireEvent.change(screen.getByLabelText("Your booking link"), { target: { value: "https://vagaro" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use this link" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/starting with https/);
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Your booking link"), { target: { value: "https://vagaro.com/me" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use this link" }));
    });
    expect(keepOwnLink).toHaveBeenLastCalledWith("https://vagaro.com/me");
    expect(push).toHaveBeenCalledWith("/onboarding/clients");
  });

  it("already connected (back from Acuity): just Continue", () => {
    show("Acuity");
    expect(screen.getByText("Acuity is connected.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/onboarding/clients");
  });
});

describe("who takes appointments", () => {
  it("🔴 their own name from signup is filled in; Continue adds the names once and moves on", async () => {
    addTeam.mockResolvedValue({ ok: true, created: 2, skipped: [] });
    render(<TeamStep existing={[]} myName="Eric Chernichaw" next="/onboarding/services" />);
    expect((screen.getByLabelText("Name 1") as HTMLInputElement).value).toBe("Eric Chernichaw");
    fireEvent.click(screen.getByRole("button", { name: "+ Add someone" }));
    fireEvent.change(screen.getByLabelText("Name 2"), { target: { value: " Dee " } });
    const go = screen.getByRole("button", { name: "Continue" });
    await act(async () => {
      go.click();
      go.click();
    });
    expect(addTeam).toHaveBeenCalledTimes(1);
    expect(addTeam).toHaveBeenCalledWith(["Eric Chernichaw", "Dee"]);
    expect(push).toHaveBeenCalledWith("/onboarding/services");
  });

  it("no one at all: asked for a name, nothing sent", async () => {
    render(<TeamStep existing={[]} myName="" next="/x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Add at least one name/);
    expect(addTeam).not.toHaveBeenCalled();
  });

  it("people already added are shown, and Continue with no new names just moves on", async () => {
    render(<TeamStep existing={[{ id: "s1", name: "Eric" }]} myName="Eric" next="/onboarding/services" />);
    expect(screen.getByRole("list", { name: "Already added" }).textContent).toContain("Eric");
    expect((screen.getByLabelText("Name 2") as HTMLInputElement).value).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(addTeam).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/onboarding/services");
  });
});

describe("what you offer", () => {
  const templates = [
    { id: "t.cut", name: "Classic", durationMin: 30, priceCents: null },
    { id: "t.beard", name: "Beard", durationMin: 15, priceCents: null },
  ];

  it("🔴 the starter list starts unticked, and adds only what was ticked, at the prices set", async () => {
    bulk.mockResolvedValue({ ok: true, created: 1, skipped: [] });
    render(<ServicesStep existing={[]} templates={templates} next="/onboarding/hours" />);
    expect((screen.getByLabelText("Offer Classic") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("button", { name: /^Add \d+ service/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("Offer Classic"));
    fireEvent.change(screen.getByLabelText("Price for Classic"), { target: { value: "35" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 1 service" }));
    });
    expect(bulk).toHaveBeenCalledWith([{ name: "Classic", durationMin: 30, price: 35 }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("a starter already on the menu isn't offered; with a menu, Continue - without one, 'later'", () => {
    const { rerender } = render(<ServicesStep existing={["classic"]} templates={templates} next="/onboarding/hours" />);
    expect(screen.queryByLabelText("Offer Classic")).toBeNull();
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/onboarding/hours");
    rerender(<ServicesStep existing={[]} templates={templates} next="/onboarding/hours" />);
    expect(screen.getByRole("link", { name: "I'll add my services later" })).toBeTruthy();
  });
});

describe("when you work", () => {
  it("each person opens the Calendar's hours sheet; Continue only once everyone has hours", async () => {
    const { rerender } = render(
      <HoursStep
        staff={[
          { id: "a", name: "Eric", hasHours: true },
          { id: "b", name: "Dee", hasHours: false },
        ]}
        next="/onboarding/clients"
      />,
    );
    expect(screen.queryByRole("link", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set hours" }));
    expect(await screen.findByRole("dialog", { name: "Dee hours" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close hours" }));
    expect(refresh).toHaveBeenCalled();
    rerender(
      <HoursStep
        staff={[
          { id: "a", name: "Eric", hasHours: true },
          { id: "b", name: "Dee", hasHours: true },
        ]}
        next="/onboarding/clients"
      />,
    );
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/onboarding/clients");
  });

  it("no one to set hours for: sent back to add them", () => {
    render(<HoursStep staff={[]} next="/onboarding/clients" />);
    expect(screen.getByRole("link", { name: "Add who takes appointments" }).getAttribute("href")).toBe("/onboarding/team");
  });
});

describe("the finish", () => {
  it("🔴 finishes setup once, after it's on screen - even where React runs effects twice", async () => {
    finishSetup.mockResolvedValue(undefined);
    const { rerender } = render(
      <StrictMode>
        <FinishSetup />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <FinishSetup />
      </StrictMode>,
    );
    await act(async () => {});
    expect(finishSetup).toHaveBeenCalledTimes(1);
  });
});
