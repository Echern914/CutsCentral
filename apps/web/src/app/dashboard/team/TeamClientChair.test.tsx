import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { TeamData } from "./page";

/**
 * Giving a team member their chair AFTER they joined.
 *
 * A barber with no chair is told, on their own screen, "Ask the shop owner to
 * link your login to your chair on the Team page" - and the Team page had no
 * control for it: a chair could only be picked while sending the invitation.
 * So an owner who invited first and set up chairs later (most of them) had no
 * way to finish the job.
 */

const updateMemberAction = vi.fn();
const createChairForMemberAction = vi.fn();
const teamAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  teamAction: (...a: unknown[]) => teamAction(...a),
  updateMemberAction: (...a: unknown[]) => updateMemberAction(...a),
  createChairForMemberAction: (...a: unknown[]) => createChairForMemberAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

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
    {
      id: "sm_joe",
      role: "BARBER",
      staffId: null,
      joinedAt: "2026-09-20T00:00:00.000Z",
      user: { id: "u_joe", name: "Joe", email: "joe@example.com", avatarUrl: null },
    },
  ],
  invites: [],
  staff: [{ id: "st_free", name: "Chair 3" }],
  inviteAvailable: true,
  ...over,
});

const chairPicker = () =>
  document.querySelector<HTMLSelectElement>('[data-qa="member-chair"]')!;

beforeEach(() => {
  updateMemberAction.mockReset();
  createChairForMemberAction.mockReset();
  teamAction.mockReset();
  toast.mockReset();
});

describe("the member chair picker", () => {
  it("🔴 says a chairless barber has nothing to see - where the owner can fix it", () => {
    render(<TeamClient initial={team()} vocab={vocab} />);
    expect(screen.getByText("No chair yet, so they have no day to see.")).toBeTruthy();
  });

  it("offers the free chairs and a brand-new one; never the owner's row", () => {
    render(<TeamClient initial={team()} vocab={vocab} />);
    // One picker: Joe's. The owner's own seat has none.
    expect(document.querySelectorAll('[data-qa="member-chair"]')).toHaveLength(1);
    const labels = [...chairPicker().options].map((o) => o.textContent);
    expect(labels).toEqual(["No chair", "Chair 3", "+ New chair for them"]);
  });

  it("🔴 linking an existing chair sends that chair", async () => {
    updateMemberAction.mockResolvedValue({ ok: true });
    teamAction.mockResolvedValue(
      team({
        members: team().members.map((m) => (m.id === "sm_joe" ? { ...m, staffId: "st_free" } : m)),
      }),
    );
    render(<TeamClient initial={team()} vocab={vocab} />);
    fireEvent.change(chairPicker(), { target: { value: "st_free" } });
    await waitFor(() =>
      expect(updateMemberAction).toHaveBeenCalledWith("sm_joe", { staffId: "st_free" }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Chair linked", "success"));
    expect(createChairForMemberAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText("No chair yet, so they have no day to see.")).toBeNull(),
    );
  });

  it("🔴 '+ New chair' makes one for them in a single step", async () => {
    createChairForMemberAction.mockResolvedValue({ ok: true });
    teamAction.mockResolvedValue(team());
    render(<TeamClient initial={team()} vocab={vocab} />);
    fireEvent.change(chairPicker(), { target: { value: "__new__" } });
    await waitFor(() => expect(createChairForMemberAction).toHaveBeenCalledWith("sm_joe"));
    expect(updateMemberAction).not.toHaveBeenCalled();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("New chair for Joe", "success"));
  });

  it("unlinking sends null", async () => {
    updateMemberAction.mockResolvedValue({ ok: true });
    teamAction.mockResolvedValue(team());
    const linked = team({
      members: team().members.map((m) => (m.id === "sm_joe" ? { ...m, staffId: "st_joe" } : m)),
      staff: [
        { id: "st_joe", name: "Joe's chair" },
        { id: "st_free", name: "Chair 3" },
      ],
    });
    render(<TeamClient initial={linked} vocab={vocab} />);
    // Their current chair is selected, and "new chair" isn't offered twice.
    expect(chairPicker().value).toBe("st_joe");
    expect([...chairPicker().options].map((o) => o.value)).not.toContain("__new__");
    fireEvent.change(chairPicker(), { target: { value: "" } });
    await waitFor(() =>
      expect(updateMemberAction).toHaveBeenCalledWith("sm_joe", { staffId: null }),
    );
  });

  it("a refusal is explained, not swallowed", async () => {
    createChairForMemberAction.mockResolvedValue({ ok: false, error: "already_has_chair" });
    render(<TeamClient initial={team()} vocab={vocab} />);
    fireEvent.change(chairPicker(), { target: { value: "__new__" } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("They already have a chair.", "error"),
    );
  });

  it("a manager sees the roster but no chair controls", () => {
    render(<TeamClient initial={team({ role: "MANAGER" })} vocab={vocab} />);
    expect(document.querySelector('[data-qa="member-chair"]')).toBeNull();
  });
});
