import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { TeamData } from "./page";

/**
 * Two ways to add a person live on the Team page, and they are opposites:
 *
 *  - a staff login puts someone INSIDE the shop (an employee);
 *  - the team link is for someone who runs their OWN business.
 *
 * The link's card used to sit above the invite, with nothing saying which was
 * which - and an employee who follows the link is told to start a business.
 * So: staff logins first, and the answer to "which one do I use" directly
 * above the other card. A shop that already runs as independent businesses,
 * with no staff logins of its own, keeps that card on top.
 */
vi.mock("./actions", () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  teamAction: vi.fn(),
  updateMemberAction: vi.fn(),
  createChairForMemberAction: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { TeamClient } = await import("./TeamClient");
const vocab = vocabularyFor("barber");

const team = (over: Partial<TeamData> = {}): TeamData => ({
  role: "OWNER",
  ownerUserId: "u_owner",
  members: [
    {
      id: "sm_owner",
      role: "OWNER",
      staffId: null,
      joinedAt: "2026-09-01T00:00:00.000Z",
      user: { id: "u_owner", name: "Snow", email: "snow@example.com", avatarUrl: null },
    },
  ],
  invites: [],
  staff: [{ id: "st_free", name: "Station 3" }],
  inviteAvailable: true,
  ...over,
});

const LinkCard = () => <div data-testid="link-card">team link</div>;
/** True when `a` comes before `b` in the page. */
const before = (a: HTMLElement, b: HTMLElement) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the Team page's order", () => {
  it("🔴 staff logins come first, and the team link's card last", () => {
    render(
      <TeamClient initial={team()} vocab={vocab}>
        <LinkCard />
      </TeamClient>,
    );
    const invite = screen.getByRole("button", { name: "Send invite" });
    const card = screen.getByTestId("link-card");
    expect(before(invite, card)).toBe(true);
    expect(before(screen.getByText("Staff logins"), card)).toBe(true);
  });

  it("🔴 'which one do I use' sits directly above the team link's card and names both", () => {
    render(
      <TeamClient initial={team()} vocab={vocab}>
        <LinkCard />
      </TeamClient>,
    );
    const which = screen.getByTestId("which-one");
    expect(which.textContent).toMatch(/Someone you employ:.*Invite someone.*staff login/);
    expect(which.textContent).toMatch(/runs their own business.*team link.*stay theirs/);
    expect(which.nextElementSibling).toBe(screen.getByTestId("link-card"));
  });

  it("a shop already running as independent businesses keeps that card on top", () => {
    render(
      <TeamClient initial={team()} vocab={vocab} independentFirst>
        <LinkCard />
      </TeamClient>,
    );
    expect(before(screen.getByTestId("link-card"), screen.getByRole("button", { name: "Send invite" }))).toBe(true);
    // Still explained, still directly above it.
    expect(screen.getByTestId("which-one").nextElementSibling).toBe(screen.getByTestId("link-card"));
  });

  it("a manager sees the roster without the owner's explainer", () => {
    render(
      <TeamClient initial={team({ role: "MANAGER" })} vocab={vocab}>
        <LinkCard />
      </TeamClient>,
    );
    expect(screen.queryByTestId("which-one")).toBeNull();
  });
});

describe("inviting someone who takes appointments", () => {
  it("🔴 with nothing picked, the choice says they get a new one - a manager gets none", () => {
    render(<TeamClient initial={team()} vocab={vocab} />);
    const pick = screen.getByRole("combobox", { name: /^Link to a / }) as HTMLSelectElement;
    expect(pick.options[0]!.textContent).toMatch(/^New .* for them$/);
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), { target: { value: "MANAGER" } });
    expect(pick.options[0]!.textContent).toMatch(/^No /);
  });

  it("the footer points at where someone is taken off the booking page", () => {
    const { container } = render(<TeamClient initial={team()} vocab={vocab} />);
    expect(container.textContent).toMatch(/takes away their staff login only/);
    expect(container.textContent).toMatch(/remove them under Calendar → Staff/);
    expect(container.textContent).not.toMatch(/deactivate/);
  });
});
