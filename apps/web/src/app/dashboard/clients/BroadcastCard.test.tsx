import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BroadcastCard } from "./BroadcastCard";
import { listBroadcastsAction } from "./broadcastActions";

vi.mock("./broadcastActions", () => ({
  listBroadcastsAction: vi.fn(async () => ({ ok: true, broadcasts: [] })),
  previewBroadcastAction: vi.fn(async () => ({
    ok: true,
    preview: {
      reachable: 3,
      considered: 3,
      emailsRemaining: null,
      limits: { subject: 60, body: 300 },
      skipped: [],
      blocker: null,
    },
  })),
  sendBroadcastAction: vi.fn(async () => ({ ok: true, recipients: 3 })),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
// Every vocabulary word this card reads is a plain string; echo the key.
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => new Proxy({}, { get: (_t, key) => String(key) }),
}));

/** The card starts collapsed; the audience picker lives behind this button. */
function openComposer() {
  fireEvent.click(screen.getByRole("button", { name: "Write a message" }));
}

/**
 * A tier is part of rewards. With rewards off the compose card offers only
 * "Everyone" and says why - the API refuses a tier audience either way, but a
 * barber should never be offered a button that can only be refused.
 */
describe("BroadcastCard audience", () => {
  it("offers Gold, Silver and Bronze while rewards are on", () => {
    render(<BroadcastCard rewardsEnabled />);
    expect(screen.getByText(/or just one loyalty group/i)).toBeTruthy();
    openComposer();

    expect(screen.getByRole("button", { name: "Everyone" })).toBeTruthy();
    for (const tier of ["Gold", "Silver", "Bronze"]) {
      expect(screen.getByRole("button", { name: tier })).toBeTruthy();
    }
    expect(screen.queryByText(/needs rewards turned on/i)).toBeNull();
  });

  it("offers only Everyone while rewards are off, and says why", () => {
    render(<BroadcastCard rewardsEnabled={false} />);
    // No talk of loyalty groups a rewards-off shop doesn't have.
    expect(screen.queryByText(/loyalty group/i)).toBeNull();
    openComposer();

    expect(screen.getByRole("button", { name: "Everyone" })).toBeTruthy();
    for (const tier of ["Gold", "Silver", "Bronze"]) {
      expect(screen.queryByRole("button", { name: tier })).toBeNull();
    }
    expect(screen.getByText(/needs rewards turned on/i)).toBeTruthy();
  });
});

describe("BroadcastCard history", () => {
  it("says which tiers a sent message was aimed at", async () => {
    const row = {
      channel: "push",
      subject: "Gold week",
      body: "Free lineups",
      status: "SENT",
      recipientCount: 42,
      sentCount: 42,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      queuedAt: null,
      sentAt: null,
      createdAt: "2026-09-01T00:00:00Z",
    };
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({
      ok: true,
      broadcasts: [
        { ...row, id: "b1", audienceTiers: ["SILVER", "GOLD"] },
        { ...row, id: "b2", subject: "Everyone", audienceTiers: [] },
      ] as never,
    });
    render(<BroadcastCard rewardsEnabled />);

    expect(await screen.findByText(/Gold and Silver members · 42 sent/)).toBeTruthy();
    // An everyone-message names no group.
    expect(screen.getAllByText(/members/)).toHaveLength(1);
  });
});
