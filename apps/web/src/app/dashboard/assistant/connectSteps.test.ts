import { describe, expect, it } from "vitest";
import { CONNECT_STEPS, CONNECT_TROUBLE } from "./ConnectSteps";

/**
 * The connect guide's CONTENT, asserted against the shipped constants.
 *
 * 🔴 THE ONE THAT MATTERS IS THE DETECTED-vs-RECOMMENDED WARNING. Claude's
 * dialog labels "Use Anthropic's hosted client metadata" as **Recommended**
 * while marking the option ChairBack actually needs — "No client ID — register
 * one automatically" — as merely **Detected**. Our authorization server
 * advertises a `registration_endpoint` (RFC 7591) and serves no hosted client
 * metadata, so the Recommended one cannot work here.
 *
 * A well-meaning edit that "tidies up" that warning would send every barber
 * down a path that fails with no useful explanation, and the failure would look
 * like ChairBack being broken. So it is pinned.
 */
describe("the Claude walkthrough", () => {
  const claude = CONNECT_STEPS.claude;
  const flat = JSON.stringify(claude).toLowerCase();

  it("🔴 tells people to take Detected, NOT Recommended", () => {
    const warned = claude.steps.filter((s) => s.warn).map((s) => s.warn!.toLowerCase());
    expect(warned.length).toBeGreaterThan(0);
    const oauthWarning = warned.join(" ");
    // Names the wrong option explicitly - "pick the detected one" alone is not
    // enough when the other one is labelled Recommended in bold.
    expect(oauthWarning).toContain("recommended");
    expect(oauthWarning).toMatch(/hosted client metadata/);
    expect(oauthWarning).toMatch(/do not pick|don't pick/);
  });

  it("names both option groups the dialog actually shows", () => {
    expect(flat).toContain("always required");
    expect(flat).toContain("no client id");
    expect(flat).toContain("register one automatically");
  });

  it("says to leave headers and Advanced alone", () => {
    // Two more boxes on that dialog a person can worry about. Silence would
    // leave them guessing whether something is required.
    expect(flat).toContain("request headers");
    expect(flat).toContain("advanced");
  });

  it("covers the whole journey, not just the dialog", () => {
    // Copy -> settings -> add -> options -> connect -> approve -> ask.
    expect(flat).toContain("copy");
    expect(flat).toContain("connectors");
    expect(flat).toContain("sign in");
    expect(flat).toContain("connect assistant");
    // Ends somewhere verifiable rather than at "it's connected".
    expect(flat).toContain("last used");
  });

  it("every step is verifiable or is a pure instruction", () => {
    // A step with no observable result is one a person cannot check, so they
    // carry on uncertain. Most must say what you should see.
    const withSee = claude.steps.filter((s) => s.see).length;
    expect(withSee).toBeGreaterThanOrEqual(claude.steps.length - 2);
  });

  it("is honest that the paid plan is the provider's requirement, not ours", () => {
    expect(claude.planNote.toLowerCase()).toContain("paid claude plan");
    expect(claude.planNote.toLowerCase()).toContain("never charges you for ai");
  });
});

describe("the ChatGPT walkthrough", () => {
  const gpt = CONNECT_STEPS.chatgpt;
  const flat = JSON.stringify(gpt).toLowerCase();

  it("gives a route plus a fallback, rather than inventing exact labels", () => {
    // Written without a screenshot of that dialog, so it must survive a
    // redesign. Being deliberately vague beats being precisely wrong.
    expect(flat).toContain("connectors");
    expect(flat).toMatch(/search your settings/);
  });

  it("still steers away from supplying your own client id", () => {
    const warned = gpt.steps.filter((s) => s.warn).map((s) => s.warn!.toLowerCase());
    expect(warned.join(" ")).toMatch(/automatic/);
  });

  it("carries the same cost-boundary sentence", () => {
    expect(gpt.planNote.toLowerCase()).toContain("never charges you for ai");
  });
});

describe("troubleshooting", () => {
  const flat = JSON.stringify(CONNECT_TROUBLE).toLowerCase();

  it("answers the failure the Recommended option causes", () => {
    expect(flat).toContain("detected");
    expect(flat).toContain("recommended");
  });

  it("says plainly when it is the AI plan and not ChairBack", () => {
    expect(flat).toMatch(/paid feature at both claude and chatgpt/);
    expect(flat).toMatch(/isn't something chairback can turn on/);
  });

  it("covers the wrong-shop case, which a multi-shop owner will hit", () => {
    expect(flat).toContain("wrong shop");
  });

  it("promises the disconnect is immediate", () => {
    expect(flat).toMatch(/immediately/);
    expect(flat).toMatch(/expire/);
  });

  it("every entry is a real question with a real answer", () => {
    for (const t of CONNECT_TROUBLE) {
      expect(t.q.length).toBeGreaterThan(10);
      expect(t.a.length).toBeGreaterThan(40);
      expect(t.a).not.toMatch(/TODO|TBD|coming soon/i);
    }
  });
});

describe("the guide never promises more than the connector does", () => {
  it("🔴 does not imply an assistant can change anything", () => {
    // Read-only is the whole product promise this release makes. A guide that
    // said "ask it to rebook someone" would be selling something that does not
    // exist and cannot be built without a separate opt-in.
    const everything = JSON.stringify(CONNECT_STEPS).toLowerCase();
    for (const verb of ["cancel a booking", "rebook", "reschedule for you", "send a text"]) {
      expect(everything).not.toContain(verb);
    }
  });

  it("its example questions are all reads", () => {
    const asks = JSON.stringify(CONNECT_STEPS).match(/“[^”]*\?”/g) ?? [];
    expect(asks.length).toBeGreaterThan(0);
    for (const a of asks) {
      expect(a.toLowerCase()).toMatch(/what|who|how/);
    }
  });
});
