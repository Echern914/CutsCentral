import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GroupView } from "./actions";

vi.mock("./actions", () => ({
  groupViewAction: vi.fn(),
  groupRescheduleAction: vi.fn(),
  cancelMemberAction: vi.fn(),
  cancelGroupAction: vi.fn(),
}));
vi.mock("../../[slug]/group/actions", () => ({ groupSlotsAction: vi.fn() }));

const { GroupManageClient } = await import("./GroupManageClient");
const actions = await import("./actions");
const slots = await import("../../[slug]/group/actions");

const viewAction = vi.mocked(actions.groupViewAction);
const rescheduleAction = vi.mocked(actions.groupRescheduleAction);
const cancelMember = vi.mocked(actions.cancelMemberAction);
const cancelAll = vi.mocked(actions.cancelGroupAction);
const slotsAction = vi.mocked(slots.groupSlotsAction);

/**
 * Managing a booked party.
 *
 * 🔴 THE FAILURE THIS SCREEN EXISTS TO PREVENT is somebody cancelling their
 * nephew and losing their own chair. Cancel-one and cancel-all are different
 * actions, never inferred from each other, and each says in words exactly who
 * it affects BEFORE it happens.
 */
const TZ = "America/New_York";
const TOKEN = "grp_tok_secret_value";

const member = (over: Partial<GroupView["members"][number]>) => ({
  appointmentId: "a1",
  manageToken: "mt_1",
  position: 0,
  firstName: "Eric",
  status: "BOOKED",
  serviceId: "svc_cut",
  serviceName: "Haircut",
  startsAt: "2026-03-14T18:00:00.000Z",
  endsAt: "2026-03-14T18:30:00.000Z",
  priceCents: 4000,
  ...over,
});

const GROUP: GroupView = {
  status: "ACTIVE",
  bookedBy: "Eric",
  shop: { slug: "cherncuts", name: "Chern Cuts", timezone: TZ },
  staff: { id: "stf_1", name: "Sam" },
  startsAt: "2026-03-14T18:00:00.000Z",
  endsAt: "2026-03-14T18:50:00.000Z",
  members: [
    member({}),
    member({
      appointmentId: "a2",
      manageToken: "mt_2",
      position: 1,
      firstName: "Brother",
      serviceId: "svc_kids",
      serviceName: "Kids cut",
      startsAt: "2026-03-14T18:30:00.000Z",
      endsAt: "2026-03-14T18:50:00.000Z",
      priceCents: 2500,
    }),
  ],
};

beforeEach(() => {
  viewAction.mockReset();
  rescheduleAction.mockReset();
  cancelMember.mockReset();
  cancelAll.mockReset();
  slotsAction.mockReset();
  viewAction.mockResolvedValue({ ok: true, group: GROUP });
});

const show = (group: GroupView = GROUP) =>
  render(<GroupManageClient token={TOKEN} initial={group} />);

describe("the whole party is visible", () => {
  it("lists every attendee, service, time and price", () => {
    show();
    expect(screen.getByText("Eric")).toBeTruthy();
    expect(screen.getByText("Brother")).toBeTruthy();
    expect(screen.getByText(/Haircut/)).toBeTruthy();
    expect(screen.getByText(/Kids cut/)).toBeTruthy();
    expect(screen.getByText("$40")).toBeTruthy();
    expect(screen.getByText("$25")).toBeTruthy();
  });

  it("says pay at the shop, and never a deposit", () => {
    show();
    expect(screen.getByText("Pay at the shop.")).toBeTruthy();
    expect(screen.queryByText(/deposit/i)).toBeNull();
  });
});

describe("🔴 cancel-one and cancel-all are different, and say so", () => {
  it("cancelling ONE promises the others keep their appointments", () => {
    show();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Cancel only Brother's appointment?");
    // 🔴 The consequence, in words, before anything happens.
    expect(dialog.textContent).toContain("Everyone else in the group keeps their appointment");
    expect(dialog.textContent).toContain("Only Brother is cancelled");
  });

  it("cancelling ALL says it takes everyone", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the whole group" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Cancel all 2 appointments?");
    expect(dialog.textContent).toContain("Everyone in this group loses their appointment");
  });

  it("🔴 cancelling one calls the MEMBER's own token, never the group's", () => {
    // The group token would cancel the whole party. Using it here is exactly
    // the accident this screen is built to make impossible.
    cancelMember.mockResolvedValue({ ok: true });
    show();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Yes, cancel Brother/ }));
    expect(cancelMember).toHaveBeenCalledWith("mt_2");
    expect(cancelAll).not.toHaveBeenCalled();
  });

  it("cancelling one leaves the rest booked on screen", async () => {
    cancelMember.mockResolvedValue({ ok: true });
    viewAction.mockResolvedValue({
      ok: true,
      group: {
        ...GROUP,
        members: [GROUP.members[0]!, { ...GROUP.members[1]!, status: "CANCELED" }],
      },
    });
    show();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Yes, cancel Brother/ }));

    await screen.findByText(/Everyone else is still booked/);
    // 🔴 Eric is still booked - not struck through, and still offered a Cancel
    // of his own. Brother is the only one marked gone.
    expect(screen.getByText("Eric").className).not.toContain("line-through");
    expect(screen.getByText("Brother").className).toContain("line-through");
    expect(screen.getByText(/Kids cut · cancelled/)).toBeTruthy();
  });

  it("cancelling all reports the group cancelled", async () => {
    cancelAll.mockResolvedValue({ ok: true, canceled: 2 });
    viewAction.mockResolvedValue({
      ok: true,
      group: { ...GROUP, status: "CANCELED" },
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the whole group" }));
    fireEvent.click(screen.getByRole("button", { name: /Yes, cancel everyone/ }));
    await screen.findByText(/The whole group has been cancelled/);
    expect(cancelAll).toHaveBeenCalledWith(TOKEN);
  });

  it("Keep it backs out without calling anything", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the whole group" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cancelAll).not.toHaveBeenCalled();
    expect(cancelMember).not.toHaveBeenCalled();
  });
});

describe("moving the whole party", () => {
  it("🔴 asks for times that fit the members still BOOKED", async () => {
    // A party that lost somebody re-asks for the SHORTER run. Asking for the
    // original one would hide times the smaller group could actually take.
    slotsAction.mockResolvedValue({
      ok: true,
      data: { timezone: TZ, totalDurationMin: 30, slots: [] },
    });
    show({
      ...GROUP,
      members: [GROUP.members[0]!, { ...GROUP.members[1]!, status: "CANCELED" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Move the whole group" }));
    await waitFor(() => expect(slotsAction).toHaveBeenCalled());
    expect(slotsAction.mock.calls[0]![1].serviceIds).toEqual(["svc_cut"]);
  });

  it("moves everyone together and stays consecutive", async () => {
    slotsAction.mockResolvedValue({
      ok: true,
      data: {
        timezone: TZ,
        totalDurationMin: 50,
        slots: [{ startsAt: "2026-03-14T20:00:00.000Z", endsAt: "2026-03-14T20:50:00.000Z" }],
      },
    });
    rescheduleAction.mockResolvedValue({
      ok: true,
      plan: {
        startsAt: "2026-03-14T20:00:00.000Z",
        endsAt: "2026-03-14T20:50:00.000Z",
        totalDurationMin: 50,
        totalPriceCents: 6500,
        unpricedCount: 0,
        members: [],
      },
    });
    viewAction.mockResolvedValue({
      ok: true,
      group: {
        ...GROUP,
        startsAt: "2026-03-14T20:00:00.000Z",
        members: [
          { ...GROUP.members[0]!, startsAt: "2026-03-14T20:00:00.000Z", endsAt: "2026-03-14T20:30:00.000Z" },
          { ...GROUP.members[1]!, startsAt: "2026-03-14T20:30:00.000Z", endsAt: "2026-03-14T20:50:00.000Z" },
        ],
      },
    });

    show();
    fireEvent.click(screen.getByRole("button", { name: "Move the whole group" }));
    fireEvent.click(await screen.findByRole("button", { name: /4:00 PM/ }));
    await screen.findByText(/Everyone has been moved/);
    // Back to back at the new time: 4:00-4:30 then 4:30-4:50.
    expect(screen.getAllByText(/4:00 PM/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4:30 PM/).length).toBeGreaterThan(0);
  });

  it("🔴 a taken time moves NOBODY, and says so", async () => {
    slotsAction.mockResolvedValue({
      ok: true,
      data: {
        timezone: TZ,
        totalDurationMin: 50,
        slots: [{ startsAt: "2026-03-14T20:00:00.000Z", endsAt: "2026-03-14T20:50:00.000Z" }],
      },
    });
    rescheduleAction.mockResolvedValue({ ok: false, code: "slot_taken" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Move the whole group" }));
    fireEvent.click(await screen.findByRole("button", { name: /4:00 PM/ }));
    expect(await screen.findByText(/Nobody was moved/)).toBeTruthy();
  });
});

describe("🔴 the token is a credential", () => {
  it("never appears in the rendered page or any link", () => {
    show();
    // Not in visible text...
    expect(document.body.textContent).not.toContain(TOKEN);
    // ...and not in an href, where a Referer would carry it onward.
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toContain(TOKEN);
    }
  });

  it("never appears in a member's rendered row either", () => {
    show();
    expect(document.body.textContent).not.toContain("mt_1");
    expect(document.body.textContent).not.toContain("mt_2");
  });
});
