import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";
import type { TeamLinksData } from "./IndependentTeam";
import type { TeamActivityItem } from "@/lib/teamNumbers";

/**
 * Snow's Team Logistics on the owner's card. What must hold:
 *  - the window is the owner's pick, and picking re-reads it from the server;
 *  - totals say how many members they're from, never read as the whole team;
 *  - a change is shown against the window before, and never for a hidden number;
 *  - the feed reads as sentences about WHO did WHAT - never anyone's numbers.
 */
const teamLinksAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  approveLinkAction: vi.fn(),
  endLinkAction: vi.fn(),
  teamLinksAction: (...a: unknown[]) => teamLinksAction(...a),
  teamActivityAction: async () => null,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("./BoothRent", () => ({ OwnerRent: () => null }));

const { IndependentTeam } = await import("./IndependentTeam");
const { activityLine, agoLabel, changeOf, totalTiles } = await import("@/lib/teamNumbers");
const vocab = vocabularyFor("barber");

const noRent = {
  current: null,
  balanceCents: 0,
  creditCents: 0,
  unpaid: [],
  rate: null,
  scheduled: null,
  nextChangeOn: null,
  earliestStart: null,
  lastPayment: null,
};

function data(period = "30d", annCuts = 12): TeamLinksData {
  return {
    period: { key: period, label: period === "7d" ? "Last 7 days" : "Last 30 days", options: ["7d", "30d", "90d"] },
    totals: {
      cuts: { value: annCuts + 8, previous: 16, sharedBy: 2, of: 2 },
      revenueCents: { value: 48000, previous: 60000, sharedBy: 1, of: 2 },
      clients: { value: null, previous: null, sharedBy: 0, of: 2 },
      rent: { paidUp: 1, of: 2 },
    },
    joinUrl: "https://getchairback.com/team/link/cmteam",
    pending: [],
    active: [
      {
        id: "a1",
        business: { name: "Ann Cuts", logoUrl: null },
        ownerName: "Ann",
        approvedAt: null,
        sharing: { shareCuts: true, shareRevenue: true, shareClients: false, shareRating: false },
        numbers: {
          cuts: annCuts,
          revenueCents: 48000,
          clients: null,
          rating: null,
          previous: { cuts: 10, revenueCents: 60000, clients: null },
        },
        rent: noRent,
      },
      {
        id: "b1",
        business: { name: "Bo Fades", logoUrl: null },
        ownerName: "Bo",
        approvedAt: null,
        sharing: { shareCuts: true, shareRevenue: false, shareClients: false, shareRating: false },
        numbers: {
          cuts: 8,
          revenueCents: null,
          clients: null,
          rating: null,
          previous: { cuts: 6, revenueCents: null, clients: null },
        },
        rent: noRent,
      },
    ],
    past: [],
  };
}

const FEED: TeamActivityItem[] = [
  { id: "e:1", at: new Date(Date.now() - 2 * 3_600_000).toISOString(), business: "Bo Fades", kind: "shared", metric: "cuts", amountCents: null, method: null },
  { id: "p:1", at: new Date(Date.now() - 6 * 3_600_000).toISOString(), business: "Ann Cuts", kind: "rent_paid", metric: null, amountCents: 15000, method: "zelle" },
  { id: "e:2", at: new Date(Date.now() - 26 * 3_600_000).toISOString(), business: "Cy Clips", kind: "left", metric: null, amountCents: null, method: null },
];

beforeEach(() => {
  teamLinksAction.mockReset();
  toast.mockReset();
});

describe("the team overview", () => {
  it("🔴 totals say how many members they are from, with the change against the window before", () => {
    render(<IndependentTeam initial={data()} vocab={vocab} />);
    const overview = document.querySelector('[data-qa="team-overview"]') as HTMLElement;
    const tiles = within(overview).getAllByRole("definition").map((d) => d.parentElement!.textContent);
    expect(tiles[0]).toBe("Cuts20↑ 25%All 2 sharing");
    expect(tiles[1]).toBe("Revenue$480↓ 20%From 1 of 2 sharing");
    expect(tiles[2]).toBe("Clients-No one shares this");
    expect(tiles[3]).toBe("Booth rent1 of 2Paid up");
    expect(overview.textContent).toContain("Last 30 days, compared with the 30 days before.");
  });

  it("🔴 a member's change shows for shared numbers only", () => {
    render(<IndependentTeam initial={data()} vocab={vocab} />);
    const ann = document.querySelectorAll('[data-qa="team-member"]')[0] as HTMLElement;
    const tiles = [...ann.querySelectorAll("dl > div")].map((d) => d.textContent);
    expect(tiles).toEqual(["Cuts12↑ 20%", "Revenue$480↓ 20%", "ClientsHidden", "RatingHidden"]);
  });

  it("🔴 picking a window re-reads it from the server and relabels everything", async () => {
    teamLinksAction.mockResolvedValue(data("7d", 4));
    render(<IndependentTeam initial={data()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(teamLinksAction).toHaveBeenCalledWith("7d");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Last 7 days" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(document.querySelector('[data-qa="team-overview"]')!.textContent).toContain(
      "Last 7 days, compared with the 7 days before.",
    );
    const ann = document.querySelectorAll('[data-qa="team-member"]')[0] as HTMLElement;
    expect(ann.querySelector("dd")!.textContent).toBe("4");
  });

  it("a window that fails to load keeps the old numbers and says so", async () => {
    teamLinksAction.mockResolvedValue(null);
    render(<IndependentTeam initial={data()} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "Last 3 months" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't load that window - try again", "error"));
    expect(screen.getByRole("button", { name: "Last 30 days" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the activity feed", () => {
  it("🔴 reads as who did what, newest first, with no numbers of theirs", () => {
    render(<IndependentTeam initial={data()} initialActivity={FEED} vocab={vocab} />);
    const lines = [...document.querySelectorAll('[data-qa="team-activity"] li')].map((li) => li.textContent);
    expect(lines).toEqual([
      "Bo Fades started sharing cuts2h ago",
      "Rent recorded for Ann Cuts: $150 (zelle)6h ago",
      "Cy Clips left the team1d ago",
    ]);
  });

  it("an empty feed says what will show up there", () => {
    render(<IndependentTeam initial={data()} initialActivity={[]} vocab={vocab} />);
    expect(screen.getByText(/Joins, leaves, sharing changes and rent you record show up here/)).toBeTruthy();
  });
});

describe("the wording helpers", () => {
  it("changeOf: up, down, same, from zero, and nothing for a hidden number", () => {
    expect(changeOf(12, 10)).toEqual({ text: "↑ 20%", trend: "up" });
    expect(changeOf(8, 10)).toEqual({ text: "↓ 20%", trend: "down" });
    expect(changeOf(10, 10)).toEqual({ text: "Same", trend: "flat" });
    expect(changeOf(3, 0)).toEqual({ text: "↑ from 0", trend: "up" });
    expect(changeOf(0, 0)).toEqual({ text: "Same", trend: "flat" });
    expect(changeOf(null, 10)).toBeNull();
    expect(changeOf(5, undefined)).toBeNull();
  });

  it("totalTiles never calls a partial sum the whole team's", () => {
    const tiles = totalTiles(data().totals!, vocab);
    expect(tiles.map((t) => t.note)).toEqual(["All 2 sharing", "From 1 of 2 sharing", "No one shares this", "Paid up"]);
  });

  it("activityLine covers every kind", () => {
    const line = (kind: TeamActivityItem["kind"], metric: string | null = null) =>
      activityLine({ id: "x", at: "", business: "Joe", kind, metric, amountCents: 5000, method: "cash" }, vocab);
    expect(line("requested")).toBe("Joe asked to join");
    expect(line("approved")).toBe("Joe joined the team");
    expect(line("declined")).toBe("You declined Joe");
    expect(line("removed")).toBe("You removed Joe");
    expect(line("withdrew")).toBe("Joe withdrew their request");
    expect(line("hid", "revenue")).toBe("Joe stopped sharing revenue");
    expect(line("shared", "clients")).toBe("Joe started sharing clients");
    expect(line("rent_paid")).toBe("Rent recorded for Joe: $50 (cash)");
  });

  it("agoLabel", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    expect(agoLabel("2026-10-15T11:59:40Z", now)).toBe("just now");
    expect(agoLabel("2026-10-15T11:30:00Z", now)).toBe("30m ago");
    expect(agoLabel("2026-10-15T09:00:00Z", now)).toBe("3h ago");
    expect(agoLabel("2026-10-13T12:00:00Z", now)).toBe("2d ago");
  });
});
