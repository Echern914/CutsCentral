import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";

/**
 * More Clients / Team / Share mishaps from the 2026-10-08 sweep:
 *
 *  - 🔴 Send invite threw after a successful invite, so the form stayed filled
 *    and a second tap cancelled the first email's link;
 *  - 🔴 Edit profile's Cancel kept the abandoned edits for the next Save;
 *  - the Log visit / +1 punch pickers floated off the left of a phone screen;
 *  - Copy link in the Share dialog said nothing (its toast drew beneath it);
 *  - a closed share sheet toasted "copied".
 */

const a = vi.hoisted(() => ({
  inviteMemberAction: vi.fn(),
  teamAction: vi.fn(),
  updateClientAction: vi.fn(),
  getShopQrAction: vi.fn(),
}));
vi.mock("./team/actions", () => ({
  inviteMemberAction: a.inviteMemberAction,
  teamAction: a.teamAction,
  removeMemberAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  updateMemberAction: vi.fn(),
  createChairForMemberAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  updateClientAction: a.updateClientAction,
}));
vi.mock("@/app/dashboard/booking/qrActions", () => ({ getShopQrAction: a.getShopQrAction }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/contactUri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contactUri")>()),
  copyText,
}));

const { TeamClient } = await import("./team/TeamClient");
const { EditClient } = await import("./clients/[id]/EditClient");
const { ClientActions } = await import("./clients/[id]/ClientActions");
const { ShareBookingDialog } = await import("./_components/ShareBookingDialog");
const { ReferralShare } = await import("./referrals/ReferralShare");

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  toast.mockReset();
  copyText.mockReset();
});

const team = {
  role: "OWNER",
  ownerUserId: "u_owner",
  members: [],
  invites: [],
  staff: [],
  inviteAvailable: true,
} as never;

describe("team invites", () => {
  it("🔴 a sent invite clears the form, without throwing", async () => {
    a.inviteMemberAction.mockResolvedValue({ ok: true });
    a.teamAction.mockResolvedValue(team);
    render(<TeamClient initial={team} vocab={vocabularyFor("barber")} />);
    const box = screen.getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "joe@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(a.inviteMemberAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("a refused invite keeps what was typed", async () => {
    a.inviteMemberAction.mockResolvedValue({ ok: false, error: "already_member" });
    render(<TeamClient initial={team} vocab={vocabularyFor("barber")} />);
    const box = screen.getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "joe@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(a.inviteMemberAction).toHaveBeenCalled());
    expect(box.value).toBe("joe@example.com");
  });
});

describe("edit profile", () => {
  it("🔴 Cancel throws the edit away: reopening shows the client as saved", () => {
    render(
      <EditClient
        clientId="c1"
        firstName="Ana"
        lastName="Diaz"
        phone="(302) 555-0142"
        email={null}
        instagram={null}
        archived={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const phone = screen.getByPlaceholderText("Phone") as HTMLInputElement;
    fireEvent.change(phone, { target: { value: "999" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    expect((screen.getByPlaceholderText("Phone") as HTMLInputElement).value).toBe("(302) 555-0142");
  });
});

describe("client action pickers", () => {
  it("open in the row's flow, never floated off a button", () => {
    render(
      <ClientActions
        clientId="c1"
        rewardsUrl="https://x.test/r/t"
        optedOut={false}
        rewards={[]}
        cards={[
          { id: null, name: "Punch card", active: true } as never,
          { id: "k2", name: "Kids card", active: true } as never,
        ]}
        promotions={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    const panel = screen.getByText("Punch which card?").parentElement as HTMLElement;
    expect(panel.className).not.toMatch(/\babsolute\b/);
    expect(panel.className).toMatch(/basis-full/);
  });
});

describe("sharing", () => {
  it("Copy link says Copied on the button, inside the dialog", async () => {
    a.getShopQrAction.mockResolvedValue({ ok: false });
    copyText.mockResolvedValue(true);
    render(
      <ShareBookingDialog open onClose={vi.fn()} bookUrl="https://x.test/book/dee" shopName="Dee's" toast={toast} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("a closed share sheet is not a copy", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn(async () => { throw abort; }) });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <ReferralShare appBase="https://x.test" code="DEE1" rows={[]} earnedMonths={0} pendingCount={0} rewardDays={30} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    // @ts-expect-error - restore jsdom
    delete navigator.share;
  });
});
