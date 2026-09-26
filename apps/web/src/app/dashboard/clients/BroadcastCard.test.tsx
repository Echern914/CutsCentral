import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BroadcastCard } from "./BroadcastCard";
import { listBroadcastsAction, removeBroadcastAction, sendBroadcastAction } from "./broadcastActions";

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
  removeBroadcastAction: vi.fn(async () => ({ ok: true })),
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

/**
 * "Edit to resend, or remove so it's not stuck there": a finished message can
 * be loaded back into the composer, or taken off the list. One still going out
 * offers neither.
 */
describe("BroadcastCard: Edit & resend, and Remove", () => {
  const sent = {
    id: "b9",
    channel: "push",
    audienceTiers: ["BRONZE"],
    subject: "Whats up!",
    body: "Two chairs open Friday",
    status: "SENT",
    recipientCount: 1,
    sentCount: 1,
    failedCount: 0,
    skippedCount: 0,
    pendingCount: 0,
    queuedAt: null,
    sentAt: null,
    createdAt: "2026-09-26T16:00:00Z",
  };

  it("Edit & resend opens the composer with that message, ready to change", async () => {
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({ ok: true, broadcasts: [sent] as never });
    render(<BroadcastCard rewardsEnabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit & resend" }));
    expect(screen.getByDisplayValue("Whats up!")).toBeTruthy();
    expect(screen.getByDisplayValue("Two chairs open Friday")).toBeTruthy();
    // Still the barber's call: nothing is sent by editing.
    expect(vi.mocked(sendBroadcastAction)).not.toHaveBeenCalled();
  });

  it("Remove asks first, then takes it off the list", async () => {
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({ ok: true, broadcasts: [sent] as never });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BroadcastCard rewardsEnabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(confirm.mock.calls[0]![0]).toMatch(/can't be taken back/);
    await waitFor(() => expect(vi.mocked(removeBroadcastAction)).toHaveBeenCalledWith("b9"));
    await waitFor(() => expect(screen.queryByText("Whats up!")).toBeNull());
    confirm.mockRestore();
  });

  it("a declined confirm removes nothing", async () => {
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({ ok: true, broadcasts: [sent] as never });
    vi.mocked(removeBroadcastAction).mockClear();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<BroadcastCard rewardsEnabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(vi.mocked(removeBroadcastAction)).not.toHaveBeenCalled();
    expect(screen.getByText("Whats up!")).toBeTruthy();
    confirm.mockRestore();
  });

  it("a message still going out offers neither", async () => {
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({
      ok: true,
      broadcasts: [{ ...sent, status: "SENDING", pendingCount: 1, sentCount: 0 }] as never,
    });
    render(<BroadcastCard rewardsEnabled />);
    expect(await screen.findByText("Whats up!")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit & resend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

/**
 * "Email or notify" on a promo lands here: the composer opens already written
 * out from the promo and aimed at the tiers picked there, ready to edit.
 */
describe("BroadcastCard from a promo", () => {
  const draft = { subject: "Gold week", body: "20% off. Show code GOLD20.", tiers: ["GOLD" as const] };

  it("opens written out and aimed", () => {
    render(<BroadcastCard rewardsEnabled draft={draft} />);
    expect((screen.getByLabelText("Notification title") as HTMLInputElement).value).toBe("Gold week");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("20% off. Show code GOLD20.");
    expect(screen.getByRole("button", { name: "Gold" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the tiers when rewards are off", () => {
    render(<BroadcastCard rewardsEnabled={false} draft={draft} />);
    expect(screen.getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("true");
  });
});
