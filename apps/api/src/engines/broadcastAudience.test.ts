import { describe, expect, it } from "vitest";
import { splitAudience, SKIP_REASON_LABEL, type AudienceClient } from "./broadcastAudience.js";

/**
 * Who a blast reaches, and who it misses and why.
 *
 * The barber is shown this number BEFORE he sends. A preview that overstates
 * the audience is how a shop concludes the feature is broken; one that
 * disagrees with the send is worse than none, so both call this.
 */
function client(over: Partial<AudienceClient> = {}): AudienceClient {
  return {
    id: "c1",
    email: "a@example.com",
    emailOptedOut: false,
    loyaltyTier: "GOLD",
    archivedAt: null,
    pushDevices: 1,
    ...over,
  };
}

describe("picking the group", () => {
  it("no tiers means everybody reachable", () => {
    const split = splitAudience(
      [client({ id: "a", loyaltyTier: "BRONZE" }), client({ id: "b", loyaltyTier: null })],
      "email",
      [],
    );
    expect(split.reachable.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it('"all the gold members" is only the gold members', () => {
    const split = splitAudience(
      [
        client({ id: "gold", loyaltyTier: "GOLD" }),
        client({ id: "silver", loyaltyTier: "SILVER" }),
        client({ id: "none", loyaltyTier: null }),
      ],
      "email",
      ["GOLD"],
    );
    expect(split.reachable.map((c) => c.id)).toEqual(["gold"]);
    expect(split.reasonCounts.not_in_audience).toBe(2);
  });
});

describe("who cannot be reached", () => {
  it("email needs an address, and says so when there isn't one", () => {
    const split = splitAudience([client({ email: null }), client({ email: "  " })], "email", []);
    expect(split.reachable).toHaveLength(0);
    expect(split.reasonCounts.no_email).toBe(2);
  });

  it("🔴 an unsubscribed client is never emailed again", () => {
    const split = splitAudience([client({ emailOptedOut: true })], "email", []);
    expect(split.reachable).toHaveLength(0);
    expect(split.reasonCounts.unsubscribed).toBe(1);
  });

  it("push needs a device - nobody can be notified without the app", () => {
    const split = splitAudience([client({ pushDevices: 0 })], "push", []);
    expect(split.reachable).toHaveLength(0);
    expect(split.reasonCounts.no_app).toBe(1);
  });

  it("an archived client is excluded on every channel", () => {
    const archived = client({ archivedAt: new Date() });
    expect(splitAudience([archived], "email", []).reachable).toHaveLength(0);
    expect(splitAudience([archived], "push", []).reachable).toHaveLength(0);
  });
});

describe("🔴 the two opt-outs are different things", () => {
  it("an SMS STOP does NOT silence email or push", () => {
    // Client.optedOut is the TCPA gate for TEXTING - a statement about someone's
    // phone bill, not about the shop. Email has its own unsubscribe, in every
    // broadcast. Conflating them would cut a client off from a channel they
    // never opted out of, and shrink every shop's list for an invisible reason.
    // The type carries no SMS opt-out at all, which is how that stays true.
    const reachable = splitAudience([client()], "email", []).reachable;
    expect(reachable).toHaveLength(1);
  });

  it("an email unsubscribe does NOT silence push", () => {
    const split = splitAudience([client({ emailOptedOut: true })], "push", []);
    expect(split.reachable).toHaveLength(1);
  });
});

describe("what the barber is told", () => {
  it("every reason has a sentence he can act on", () => {
    for (const [reason, label] of Object.entries(SKIP_REASON_LABEL)) {
      expect(label.length, reason).toBeGreaterThan(0);
      expect(label, reason).not.toMatch(/error|invalid|null/i);
    }
  });

  it("the counts add up to the whole book, so no one is unaccounted for", () => {
    const clients = [
      client({ id: "1" }),
      client({ id: "2", email: null }),
      client({ id: "3", emailOptedOut: true }),
      client({ id: "4", archivedAt: new Date() }),
      client({ id: "5", loyaltyTier: "BRONZE" }),
    ];
    const split = splitAudience(clients, "email", ["GOLD"]);
    const skipped = Object.values(split.reasonCounts).reduce((a, b) => a + b, 0);
    expect(split.reachable.length + skipped).toBe(clients.length);
  });
});
