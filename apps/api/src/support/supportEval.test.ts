/**
 * The support-intelligence baseline: measured, pinned, and guarded.
 *
 * Three jobs:
 *
 * 1. INVENTORY INTEGRITY — the capability inventory and fixtures may only
 *    reference corpus entries and MCP tools that actually exist, so removing
 *    a help entry or renaming a tool breaks this suite instead of silently
 *    rotting the support map (the stale-knowledge failure this arc is about).
 *
 * 2. THE RATCHET — `runSupportEval()` must reproduce the committed baseline
 *    EXACTLY. Any change to the matcher, the corpus, or the MCP help tool
 *    moves fixtures between behavior classes and fails this test; the fix is
 *    to regenerate the baseline (see regenerateBaseline.ts) and review the
 *    diff — never to delete the difficult fixture.
 *
 * 3. DEFECT PINS — the specific baseline failures the next PRs exist to fix
 *    are asserted AS CURRENT TRUTH, each marked `BASELINE DEFECT`. When a fix
 *    lands, its pin fails, and flipping the assertion is the reviewed record
 *    that the defect died. A pin that still passes after its "fix" merged
 *    means the fix didn't work.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { helpAnswerById } from "@chairback/config/helpMatch";
import { TOOL_POLICIES } from "../mcp/toolPolicy.js";
import { toolDefinition } from "../mcp/tools/index.js";
import { capabilityById, SUPPORT_CAPABILITIES } from "./capabilities.js";
import { SUPPORT_FIXTURES } from "./evalFixtures.js";
import { boundToolReachable, observeMcp, runSupportEval } from "./evalHarness.js";
import {
  OBSERVED_BEHAVIORS,
  SUPPORT_ACTORS,
  SUPPORT_CHANNELS,
  SUPPORT_OUTCOMES,
} from "./outcomes.js";
import { SUPPORT_EVAL_BASELINE } from "./supportEvalBaseline.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("outcome taxonomy", () => {
  it("carries the seven pipeline outcomes and five observed behaviors", () => {
    expect(SUPPORT_OUTCOMES).toEqual([
      "ANSWERED",
      "ACTION_COMPLETED",
      "ACTION_REQUIRES_CONFIRMATION",
      "NEEDS_ONE_CLARIFICATION",
      "TEMPORARILY_UNAVAILABLE",
      "ESCALATION_REQUIRED",
      "UNSUPPORTED",
    ]);
    expect(OBSERVED_BEHAVIORS).toHaveLength(5);
    expect(SUPPORT_ACTORS).toContain("verified_customer");
    expect(SUPPORT_CHANNELS).toEqual(["in_app", "mcp"]);
  });
});

describe("capability inventory integrity", () => {
  it("has unique ids and every fixture references a real capability", () => {
    const ids = SUPPORT_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of SUPPORT_FIXTURES) {
      expect(capabilityById(f.capabilityId), `fixture ${f.id}`).toBeDefined();
    }
    const fids = SUPPORT_FIXTURES.map((f) => f.id);
    expect(new Set(fids).size).toBe(fids.length);
  });

  it("🔴 every referenced corpus id exists in the live help corpus", () => {
    // THE STALE-KNOWLEDGE TRIPWIRE: delete or rename a help entry that the
    // support map depends on and this names it, instead of the assistant
    // quietly losing an answer.
    for (const cap of SUPPORT_CAPABILITIES) {
      for (const id of [...cap.corpusIds, ...(cap.wrongCorpusIds ?? [])]) {
        expect(helpAnswerById(id), `capability ${cap.id} references ${id}`).toBeDefined();
      }
    }
  });

  it("🔴 every bound MCP tool exists in the policy table and is reachable", () => {
    const policyNames = new Set(TOOL_POLICIES.map((p) => p.name));
    for (const cap of SUPPORT_CAPABILITIES) {
      if (cap.mcpTool === null) continue;
      expect(policyNames.has(cap.mcpTool), `capability ${cap.id} -> ${cap.mcpTool}`).toBe(
        true,
      );
      expect(toolDefinition(cap.mcpTool), `handler for ${cap.mcpTool}`).toBeDefined();
      expect(boundToolReachable(cap), `manager reachability of ${cap.mcpTool}`).toBe(true);
    }
  });

  it("fixture actors stay inside their capability's actor list", () => {
    for (const f of SUPPORT_FIXTURES) {
      const cap = capabilityById(f.capabilityId)!;
      // Must-refuse capabilities (empty actor list) are probed BY design with
      // actors who should be refused; everything else must match the matrix.
      if (cap.actors.length === 0) continue;
      expect(cap.actors, `fixture ${f.id} actor ${f.actor}`).toContain(f.actor);
    }
  });

  it("consequential capabilities all require confirmation", () => {
    for (const cap of SUPPORT_CAPABILITIES) {
      if (!cap.readOnly) {
        expect(cap.confirmationRequired, `capability ${cap.id} mutates`).toBe(true);
      }
    }
  });
});

describe("fixture hygiene — no PII, no secrets, ever", () => {
  const sources = ["evalFixtures.ts", "capabilities.ts"].map((f) =>
    readFileSync(join(here, f), "utf8"),
  );

  it("contains no phone-number-shaped digit runs", () => {
    for (const src of sources) expect(src).not.toMatch(/\d{7,}/);
  });

  it("contains no email address except the support channel", () => {
    for (const src of sources) {
      const emails = src.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      for (const e of emails) expect(e).toBe("support@getchairback.com");
    }
  });

  it("contains no token/secret-shaped strings", () => {
    for (const src of sources) {
      expect(src).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(src).not.toMatch(/whsec_/);
      expect(src).not.toMatch(/AKIA[A-Z0-9]{8,}/);
      expect(src).not.toMatch(/[a-f0-9]{32,}/);
    }
  });
});

describe("the baseline ratchet", () => {
  it("🔴 the eval reproduces the committed baseline exactly", async () => {
    const report = await runSupportEval();
    // If this fails, support behavior CHANGED. Review whether each moved
    // fixture moved in the right direction, then regenerate the baseline:
    //   pnpm --filter @chairback/api exec tsx --env-file=../../.env src/support/regenerateBaseline.ts
    expect(report).toEqual(SUPPORT_EVAL_BASELINE);
  });

  it("the baseline is honest about how bad today is", () => {
    // These are FLOOR assertions on the recorded baseline, so nobody can
    // quietly regenerate it into a rosier story without touching this file:
    // today the in-app assistant confidently misanswers more than a fifth of
    // the fixture set and offers no human escalation on most misses.
    const b = SUPPORT_EVAL_BASELINE;
    const inAppTotal = Object.values(b.inApp).reduce((a, n) => a + n, 0);
    expect(inAppTotal).toBeGreaterThanOrEqual(50);
    expect(b.wrongInApp.length).toBeGreaterThanOrEqual(10);
    expect(b.corpusGapCapabilities.length).toBeGreaterThanOrEqual(10);
    expect(b.mcpToolGaps.length).toBeGreaterThanOrEqual(8);
    expect(b.missesWithoutEscalation.inApp).toBeGreaterThanOrEqual(20);
  });
});

describe("baseline defect pins — flip these as the fixes land", () => {
  it("BASELINE DEFECT: the help tool's own schema example returns zero features", async () => {
    // help.ts's query description literally suggests "take a deposit", and
    // searchFeatures' AND semantics guarantee that phrasing matches nothing.
    const obs = await observeMcp({
      id: "pin-deposit",
      capabilityId: "refunds_deposits_howto",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "take a deposit",
      probe: "terse",
    });
    expect(obs.featureHits).toBe(0);
  });

  it("BASELINE DEFECT: MCP suggestions carry no bodies and no tool can redeem them", async () => {
    const obs = await observeMcp({
      id: "pin-bodies",
      capabilityId: "add_to_apple_wallet",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "How do I add it to Apple Wallet?",
      probe: "canonical",
    });
    expect(obs.answerId).toBeNull();
    expect(obs.suggestionIds.length).toBeGreaterThan(0);
    expect(obs.suggestionsHaveBodies).toBe(false);
    // The bodies exist server-side (helpAnswerById) but no MCP tool exposes
    // them — the single biggest cause of "the connector doesn't know".
    expect(toolDefinition("help_get_answer")).toBeUndefined();
  });

  it("BASELINE DEFECT: the total-miss path drops the route to a human", async () => {
    // findHelp's zero-score fallback includes contact-human; the MCP wire
    // slices suggestions to 4 and cuts exactly that entry.
    const obs = await observeMcp({
      id: "pin-esc",
      capabilityId: "human_help",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "Do you integrate with QuickBooks?",
      probe: "canonical",
    });
    expect(obs.answerId).toBeNull();
    expect(obs.suggestionIds).toHaveLength(4);
    expect(obs.escalationOffered).toBe(false);
  });

  it("BASELINE DEFECT: rewards recovery routes to DISABLING rewards", () => {
    // "How do I recover my rewards?" — the recovery flow shipped in #339-#343
    // but has no corpus entry, and the matcher confidently serves the entry
    // about turning rewards off instead.
    expect(SUPPORT_EVAL_BASELINE.perFixture["rewards-recover"]?.in_app).toBe(
      "wrong_answer",
    );
  });

  it("BASELINE DEFECT: eleven shipped capabilities have no corpus entry at all", () => {
    expect(SUPPORT_EVAL_BASELINE.corpusGapCapabilities).toContain(
      "add_to_apple_calendar",
    );
    expect(SUPPORT_EVAL_BASELINE.corpusGapCapabilities).toContain("recover_rewards");
    expect(SUPPORT_EVAL_BASELINE.corpusGapCapabilities).toContain(
      "confirmation_email_missing",
    );
  });
});
