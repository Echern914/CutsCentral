import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { MyTeamsData } from "./TeamsClient";

/**
 * A barber's privacy switches for a team. The rule that matters: the page
 * never says a number is hidden (or shared) until the server has agreed - a
 * switch reads "Saving…" until then, and a failed save leaves it as it was.
 */

const setSharingAction = vi.fn();
const leaveTeamAction = vi.fn();
const myTeamsAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  setSharingAction: (...a: unknown[]) => setSharingAction(...a),
  leaveTeamAction: (...a: unknown[]) => leaveTeamAction(...a),
  myTeamsAction: (...a: unknown[]) => myTeamsAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { TeamsClient } = await import("./TeamsClient");
const vocab = vocabularyFor("barber");

const NONE = { shareCuts: false, shareRevenue: false, shareClients: false, shareRating: false };

const data = (over: Partial<MyTeamsData["links"][number]> = {}): MyTeamsData => ({
  business: { id: "own", name: "Joe's Cuts" },
  links: [
    {
      id: "tl1",
      status: "ACTIVE",
      requestedAt: "2026-09-20T00:00:00.000Z",
      approvedAt: "2026-09-21T00:00:00.000Z",
      team: { name: "United Barbershop" },
      sharing: NONE,
      theySee: { cuts: null, revenueCents: null, clients: null, rating: null },
      rent: null,
      ...over,
    },
  ],
});

const sw = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-qa="share-${key}"]`)!;

beforeEach(() => {
  setSharingAction.mockReset();
  leaveTeamAction.mockReset();
  myTeamsAction.mockReset();
  toast.mockReset();
});

describe("what a team can see", () => {
  it("starts with everything hidden, and says so in the preview", () => {
    render(<TeamsClient initial={data()} vocab={vocab} />);
    for (const key of ["shareCuts", "shareRevenue", "shareClients", "shareRating"]) {
      expect(sw(key).textContent).toBe("Hidden");
      expect(sw(key).getAttribute("aria-checked")).toBe("false");
    }
    expect(document.querySelector('[data-qa="they-see"]')!.textContent).toBe(
      "Cuts hidden · Revenue hidden · Clients hidden · Rating hidden",
    );
  });

  it("🔴 a switch reads Saving… until the server answers, then shows the server's answer", async () => {
    let resolve!: (v: unknown) => void;
    setSharingAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<TeamsClient initial={data()} vocab={vocab} />);

    fireEvent.click(sw("shareCuts"));
    expect(setSharingAction).toHaveBeenCalledWith("tl1", { shareCuts: true });
    expect(sw("shareCuts").textContent).toBe("Saving…");
    expect(sw("shareCuts").getAttribute("aria-checked")).toBe("false");

    resolve({
      ok: true,
      sharing: { ...NONE, shareCuts: true },
      theySee: { cuts: 42, revenueCents: null, clients: null, rating: null },
    });
    await waitFor(() => expect(sw("shareCuts").textContent).toBe("Shared"));
    expect(sw("shareCuts").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-qa="they-see"]')!.textContent).toBe(
      "Cuts 42 · Revenue hidden · Clients hidden · Rating hidden",
    );
  });

  it("🔴 a failed save changes nothing and says so", async () => {
    setSharingAction.mockResolvedValue({ ok: false, error: "network_error" });
    render(<TeamsClient initial={data({ sharing: { ...NONE, shareRevenue: true } })} vocab={vocab} />);
    fireEvent.click(sw("shareRevenue"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't save that - nothing changed", "error"),
    );
    expect(sw("shareRevenue").textContent).toBe("Shared");
  });

  it("a request still waiting says the team sees nothing yet", () => {
    render(
      <TeamsClient initial={data({ status: "PENDING", approvedAt: null, theySee: null })} vocab={vocab} />,
    );
    expect(screen.getByText("Waiting for the owner to approve you")).toBeTruthy();
    expect(screen.getByText(/Nothing until they approve you/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Withdraw request" })).toBeTruthy();
  });

  it("no teams: tells them how to join one", () => {
    render(<TeamsClient initial={{ business: { id: "own", name: "Joe's Cuts" }, links: [] }} vocab={vocab} />);
    expect(screen.getByText("You're not on a team.")).toBeTruthy();
  });
});

describe("leaving", () => {
  it("asks first; says it's done only once a fresh read agrees", async () => {
    leaveTeamAction.mockResolvedValue({ ok: true });
    myTeamsAction.mockResolvedValue({ business: { id: "own", name: "Joe's Cuts" }, links: [] });
    render(<TeamsClient initial={data()} vocab={vocab} />);

    fireEvent.click(screen.getByRole("button", { name: "Leave team" }));
    expect(leaveTeamAction).not.toHaveBeenCalled();
    expect(screen.getByText("Leave United Barbershop team?")).toBeTruthy();

    const confirm = screen
      .getAllByRole("button", { name: "Leave team" })
      .find((b) => b.className.includes("bg-rose"))!;
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("You left United Barbershop's team", "success"),
    );
    expect(screen.getByText("You're not on a team.")).toBeTruthy();
  });

  it("a failed leave keeps them on the team and says so", async () => {
    leaveTeamAction.mockResolvedValue({ ok: false, error: "network_error" });
    render(<TeamsClient initial={data()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave team" }));
    const confirm = screen
      .getAllByRole("button", { name: "Leave team" })
      .find((b) => b.className.includes("bg-rose"))!;
    fireEvent.click(confirm);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't leave - try again", "error"));
    expect(myTeamsAction).not.toHaveBeenCalled();
  });
});

describe("booth rent records", () => {
  const owed = {
    current: null,
    balanceCents: 15000,
    creditCents: 0,
    unpaid: [{ start: "2026-09-17", end: "2026-09-23", amountCents: 15000, dueCents: 15000 }],
    rate: null,
    scheduled: null,
    nextChangeOn: null,
    earliestStart: "2026-09-24",
    lastPayment: null,
  };

  it("🔴 a team they left keeps its rent readable - the name and the rent, nothing else", () => {
    render(
      <TeamsClient
        initial={{
          ...data(),
          past: [{ id: "old1", endedAt: "2026-09-22T12:00:00.000Z", team: { name: "Old Shop" }, rent: owed }],
        }}
        vocab={vocab}
      />,
    );
    const past = document.querySelector('[data-qa="past-teams"]')!;
    expect(past.textContent).toContain("Old Shop");
    expect(past.querySelector('[data-qa="rent-total"]')!.textContent).toBe(
      "You owe $150 in total · unpaid since Sep 17",
    );
    // Read-only: History, and no switches or Leave for a team they're not on.
    expect([...past.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["History"]);
  });

  it("🔴 asking to rejoin, the old record still shows", () => {
    render(<TeamsClient initial={data({ status: "PENDING", approvedAt: null, theySee: null, rent: owed })} vocab={vocab} />);
    expect(document.querySelector('[data-qa="rent-total"]')!.textContent).toBe(
      "You owe $150 in total · unpaid since Sep 17",
    );
  });
});
