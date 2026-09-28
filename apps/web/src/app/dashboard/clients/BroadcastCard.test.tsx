import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BroadcastCard } from "./BroadcastCard";
import {
  broadcastServiceOptionsAction,
  listBroadcastsAction,
  previewBroadcastAction,
  removeBroadcastAction,
  sendBroadcastAction,
} from "./broadcastActions";

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
      channels: {
        push: { reachable: 3, skipped: [], unavailable: false },
        email: { reachable: 1, skipped: [], unavailable: false },
      },
      tierCounts: { GOLD: 2, SILVER: 0, BRONZE: 1 },
    },
  })),
  sendBroadcastAction: vi.fn(async () => ({ ok: true, recipients: 3 })),
  removeBroadcastAction: vi.fn(async () => ({ ok: true })),
  broadcastServiceOptionsAction: vi.fn(async () => ({
    ok: true,
    options: [
      { key: "id:svc1", label: "Fade", source: "menu", clients: 4 },
      { key: "name:braids", label: "Braids", source: "synced", clients: 1 },
    ],
  })),
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
    expect(screen.getByText(/or just one rewards tier/i)).toBeTruthy();
    openComposer();

    expect(screen.getByRole("button", { name: "Everyone" })).toBeTruthy();
    expect(screen.getByText("Or by rewards tier:")).toBeTruthy();
    for (const tier of ["Gold", "Silver", "Bronze"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${tier}`) })).toBeTruthy();
    }
    expect(screen.queryByText(/needs rewards turned on/i)).toBeNull();
  });

  it("says how many clients are in each tier, so an empty one is obvious", async () => {
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    expect(await screen.findByRole("button", { name: "Gold · 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Silver · 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bronze · 1" })).toBeTruthy();
  });

  it("counts the group on both channels", async () => {
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    expect(await screen.findByText(/will get this notification/)).toBeTruthy();
    expect(screen.getByText("As an email: 1 of 3.")).toBeTruthy();
  });

  it("offers only Everyone while rewards are off, and says why", () => {
    render(<BroadcastCard rewardsEnabled={false} />);
    // No talk of loyalty groups a rewards-off shop doesn't have.
    expect(screen.queryByText(/loyalty group/i)).toBeNull();
    openComposer();

    expect(screen.getByRole("button", { name: "Everyone" })).toBeTruthy();
    for (const tier of ["Gold", "Silver", "Bronze"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${tier}`) })).toBeNull();
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
    expect(screen.getByRole("button", { name: /^Gold/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the tiers when rewards are off", () => {
    render(<BroadcastCard rewardsEnabled={false} draft={draft} />);
    expect(screen.getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("BroadcastCard email permission", () => {
  /** What the API really answers when nobody has a recorded yes (#515). */
  const nobodySaidYes = {
    reachable: 0,
    considered: 12,
    emailsRemaining: 500,
    limits: { subject: 120, body: 4000 },
    skipped: [{ reason: "not_permitted", count: 12, label: "Hasn't agreed to your marketing emails yet" }],
    blocker: { kind: "no_recipients", message: "Nobody in this group can be reached on that channel yet." },
    channels: {
      push: {
        reachable: 5,
        skipped: [{ reason: "no_app", count: 7, label: "Hasn't installed the app" }],
        unavailable: false,
      },
      email: {
        reachable: 0,
        skipped: [{ reason: "not_permitted", count: 12, label: "Hasn't agreed to your marketing emails yet" }],
        unavailable: false,
      },
    },
    tierCounts: { GOLD: 0, SILVER: 0, BRONZE: 0 },
  };

  async function withPreview(preview: unknown, run: () => Promise<void>) {
    const original = vi.mocked(previewBroadcastAction).getMockImplementation();
    vi.mocked(previewBroadcastAction).mockImplementation((async () => ({ ok: true, preview })) as never);
    try {
      await run();
    } finally {
      vi.mocked(previewBroadcastAction).mockImplementation(original!);
    }
  }

  it("🔴 at zero it still shows the count, the reason, and the channel that does reach them", async () => {
    await withPreview(nobodySaidYes, async () => {
      render(<BroadcastCard rewardsEnabled />);
      openComposer();
      fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
      expect(await screen.findByText(/has said yes to your marketing emails yet/)).toBeTruthy();
      expect(screen.getByText(/that reaches 5 of them/)).toBeTruthy();
      // The breakdown and both numbers are on screen, not hidden by the refusal.
      expect(screen.getByText(/12 · Hasn't agreed to your marketing emails yet/)).toBeTruthy();
      expect(screen.getByText(/will get this email/).textContent).toMatch(/^0 of 12/);
      expect(screen.getByText("As an app notification: 5 of 12.")).toBeTruthy();
      // Nothing to send to, so nothing to press.
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("never gives a count for email the shop can't send yet", async () => {
    const noAddress = {
      ...nobodySaidYes,
      reachable: 4,
      skipped: [],
      blocker: { kind: "no_postal_address", message: "Add your shop's street address first." },
      channels: {
        push: nobodySaidYes.channels.push,
        email: { reachable: 4, skipped: [], unavailable: true },
      },
    };
    await withPreview(noAddress, async () => {
      render(<BroadcastCard rewardsEnabled />);
      openComposer();
      fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
      expect(await screen.findByText("This email can't be sent from your shop yet.")).toBeTruthy();
      expect(screen.getByText("Add your shop's street address first.")).toBeTruthy();
      expect(screen.queryByText(/will get this email/)).toBeNull();
    });
  });
});

/**
 * "Send it to everyone who had a fade": the By service picker. Each service
 * says how many had it; nothing picked sends nothing; the pick and the window
 * are what the preview and the send are asked about.
 */
describe("BroadcastCard by service", () => {
  it("lists services with their counts, and a synced name says where it came from", async () => {
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    fireEvent.click(screen.getByRole("button", { name: "By service" }));
    expect(await screen.findByRole("button", { name: "Fade · 4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Braids (from Acuity) · 1" })).toBeTruthy();
    expect(vi.mocked(broadcastServiceOptionsAction)).toHaveBeenLastCalledWith(365);
  });

  it("🔴 with nothing picked it counts nobody and cannot send", async () => {
    vi.mocked(previewBroadcastAction).mockClear();
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    fireEvent.change(screen.getByLabelText("Notification title"), { target: { value: "Fade week" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Book a fade" } });
    await waitFor(() => expect(vi.mocked(previewBroadcastAction)).toHaveBeenCalled());
    vi.mocked(previewBroadcastAction).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "By service" }));
    expect(await screen.findByText(/Pick at least one service/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    // Never asked about an empty pick - the API would refuse it anyway.
    expect(vi.mocked(previewBroadcastAction)).not.toHaveBeenCalled();
  });

  it("asks the preview about the pick and the window, and sends them", async () => {
    vi.mocked(previewBroadcastAction).mockClear();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    fireEvent.click(screen.getByRole("button", { name: "By service" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fade · 4" }));
    await waitFor(() =>
      expect(vi.mocked(previewBroadcastAction)).toHaveBeenLastCalledWith({
        channel: "push",
        tiers: [],
        services: { keys: ["id:svc1"], sinceDays: 365 },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    await waitFor(() => expect(vi.mocked(broadcastServiceOptionsAction)).toHaveBeenLastCalledWith(90));
    fireEvent.click(await screen.findByRole("button", { name: "Gold" }));
    await waitFor(() =>
      expect(vi.mocked(previewBroadcastAction)).toHaveBeenLastCalledWith({
        channel: "push",
        tiers: ["GOLD"],
        services: { keys: ["id:svc1"], sinceDays: 90 },
      }),
    );

    fireEvent.change(screen.getByLabelText("Notification title"), { target: { value: "Fade week" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Book a fade" } });
    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);
    expect(confirm.mock.calls[0]![0]).toMatch(/who had Fade/);
    await waitFor(() =>
      expect(vi.mocked(sendBroadcastAction)).toHaveBeenLastCalledWith({
        channel: "push",
        tiers: ["GOLD"],
        services: { keys: ["id:svc1"], sinceDays: 90 },
        subject: "Fade week",
        body: "Book a fade",
      }),
    );
    confirm.mockRestore();
  });

  it("Everyone clears the service pick", async () => {
    render(<BroadcastCard rewardsEnabled />);
    openComposer();
    fireEvent.click(screen.getByRole("button", { name: "By service" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fade · 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    expect(screen.getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Fade · 4" })).toBeNull();
  });

  it("history says which services a message was for", async () => {
    vi.mocked(listBroadcastsAction).mockResolvedValueOnce({
      ok: true,
      broadcasts: [
        {
          id: "b1",
          channel: "push",
          audienceTiers: [],
          audienceServiceKeys: ["id:svc1", "name:braids"],
          audienceServiceLabels: ["Fade", "Braids"],
          audienceSinceDays: 90,
          subject: "Fade week",
          body: "Book a fade",
          status: "SENT",
          recipientCount: 5,
          sentCount: 5,
          failedCount: 0,
          skippedCount: 0,
          pendingCount: 0,
          queuedAt: null,
          sentAt: null,
          createdAt: "2026-09-01T00:00:00Z",
        },
      ] as never,
    });
    render(<BroadcastCard rewardsEnabled />);
    expect(await screen.findByText(/Had Fade and Braids · 5 sent/)).toBeTruthy();
  });
});
