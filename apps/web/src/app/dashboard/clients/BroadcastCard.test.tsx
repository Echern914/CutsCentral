import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BroadcastCard } from "./BroadcastCard";

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
