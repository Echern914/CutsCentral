import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { TeamLinksData } from "./IndependentTeam";

/**
 * The owner's independent-team card. What must hold:
 *  - a number a barber hasn't shared reads "Hidden" - never a zero, never a blank;
 *  - approving says so only after the server confirmed;
 *  - "Link copied" only when the copy actually happened.
 */

const approveLinkAction = vi.fn();
const endLinkAction = vi.fn();
const teamLinksAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  approveLinkAction: (...a: unknown[]) => approveLinkAction(...a),
  endLinkAction: (...a: unknown[]) => endLinkAction(...a),
  teamLinksAction: (...a: unknown[]) => teamLinksAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("./BoothRent", () => ({ OwnerRent: () => null }));

const { IndependentTeam } = await import("./IndependentTeam");
const vocab = vocabularyFor("barber");

const base: TeamLinksData = {
  joinUrl: "https://getchairback.com/team/link/cmteamshop0001",
  pending: [
    {
      id: "p1",
      business: { name: "Mike Fades", logoUrl: null },
      ownerName: "Mike",
      requestedAt: "2026-09-23T00:00:00.000Z",
    },
  ],
  active: [
    {
      id: "a1",
      business: { name: "Joe's Cuts", logoUrl: null },
      ownerName: "Joe",
      approvedAt: "2026-09-20T00:00:00.000Z",
      sharing: { shareCuts: true, shareRevenue: false, shareClients: false, shareRating: true },
      numbers: { cuts: 42, revenueCents: null, clients: null, rating: { average: 4.86, count: 37 } },
      rent: { amountCents: null, period: null, paidThisPeriodCents: 0, dueCents: 0, lastPayment: null },
    },
  ],
};

beforeEach(() => {
  approveLinkAction.mockReset();
  endLinkAction.mockReset();
  teamLinksAction.mockReset();
  toast.mockReset();
});

describe("the team table", () => {
  it("🔴 unshared numbers read Hidden - shared ones read the value", () => {
    render(<IndependentTeam initial={base} vocab={vocab} />);
    const cells = [...document.querySelectorAll('[data-qa="team-member"] dd')].map((d) => d.textContent);
    expect(cells).toEqual(["42", "Hidden", "Hidden", "4.9 ★ (37)"]);
    const labels = [...document.querySelectorAll('[data-qa="team-member"] dt')].map((d) => d.textContent);
    expect(labels).toEqual(["Cuts", "Revenue", "Clients", "Rating"]);
  });

  it("an empty team says how to start", () => {
    render(<IndependentTeam initial={{ ...base, pending: [], active: [] }} vocab={vocab} />);
    expect(screen.getByText(/No one yet. Send your team link/)).toBeTruthy();
  });
});

describe("approving", () => {
  it("🔴 says they're on the team only after the server confirmed, then shows the fresh list", async () => {
    let resolve!: (v: unknown) => void;
    approveLinkAction.mockReturnValue(new Promise((r) => (resolve = r)));
    teamLinksAction.mockResolvedValue({ ...base, pending: [] });
    render(<IndependentTeam initial={base} vocab={vocab} />);

    fireEvent.click(document.querySelector('[data-qa="approve-link"]')!);
    expect(approveLinkAction).toHaveBeenCalledWith("p1");
    expect(screen.getByText("Approving…")).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();

    resolve({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Mike Fades is on your team", "success"));
    expect(screen.queryByText("Mike Fades")).toBeNull();
  });

  it("🔴 declining says 'Declining…' - never 'Approving…'", async () => {
    let resolve!: (v: unknown) => void;
    endLinkAction.mockReturnValue(new Promise((r) => (resolve = r)));
    teamLinksAction.mockResolvedValue({ ...base, pending: [] });
    render(<IndependentTeam initial={base} vocab={vocab} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(screen.getByText("Declining…")).toBeTruthy();
    expect(screen.queryByText("Approving…")).toBeNull();

    resolve({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Request declined", "success"));
  });

  it("a request someone already handled is explained, not reported as a failure to retry", async () => {
    approveLinkAction.mockResolvedValue({ ok: false, error: "not_found" });
    teamLinksAction.mockResolvedValue({ ...base, pending: [] });
    render(<IndependentTeam initial={base} vocab={vocab} />);
    fireEvent.click(document.querySelector('[data-qa="approve-link"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("That was already handled", "error"));
  });
});

describe("the team link", () => {
  it("'Link copied' only after the clipboard accepted it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<IndependentTeam initial={base} vocab={vocab} />);
    fireEvent.click(document.querySelector('[data-qa="copy-team-link"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Link copied", "success"));
    expect(writeText).toHaveBeenCalledWith(base.joinUrl);
  });

  it("a blocked clipboard says how to copy it instead of claiming it worked", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    render(<IndependentTeam initial={base} vocab={vocab} />);
    fireEvent.click(document.querySelector('[data-qa="copy-team-link"]')!);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't copy - press and hold the link to copy it", "error"),
    );
    expect(toast).not.toHaveBeenCalledWith("Link copied", "success");
  });
});
