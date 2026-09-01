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
import { capabilityById, SUPPORT_CAPABILITIES } from "@chairback/config";
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
  const sources = [
    join(here, "evalFixtures.ts"),
    // The registry moved to @chairback/config in PR 1; the hygiene scan
    // follows it rather than quietly checking one file less.
    join(here, "../../../../packages/config/src/supportCapabilities.ts"),
  ].map((f) => readFileSync(f, "utf8"));

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

  it("🔴 the in-app channel gives ZERO confidently-wrong answers", () => {
    // The baseline this replaced had FIFTEEN. A confidently wrong answer is
    // the most expensive thing a help surface produces, because the asker
    // acts on it, so this is a hard zero rather than a threshold.
    const b = SUPPORT_EVAL_BASELINE;
    expect(b.inApp.wrong_answer).toBe(0);
    expect(b.wrongInApp).toEqual([]);
  });

  it("🔴 every in-app miss carries a route to a human", () => {
    // The engine attaches an escalation to every outcome except ANSWERED, and
    // both adapters render it. Baseline before PR 1: 35 misses with no way out.
    expect(SUPPORT_EVAL_BASELINE.missesWithoutEscalation.inApp).toBe(0);
  });

  it("no capability is left with zero corpus coverage", () => {
    // Eleven shipped features were unanswerable by construction. Adding one
    // back without an entry fails here rather than at a customer.
    expect(SUPPORT_EVAL_BASELINE.corpusGapCapabilities).toEqual([]);
  });

  it("the in-app channel answers most of the fixture set outright", () => {
    const b = SUPPORT_EVAL_BASELINE;
    const total = Object.values(b.inApp).reduce((a, n) => a + n, 0);
    expect(total).toBeGreaterThanOrEqual(50);
    // A floor, not a target: it may rise, and the ratchet reviews it when it
    // moves either way. It may not silently fall back toward the old 18/55.
    expect(b.inApp.correct_answer / total).toBeGreaterThan(0.75);
  });

  it("🔴 MCP now matches in-app: no wrong answers, no miss without a way out", () => {
    // The gap PR 2 existed to close. Same corpus, same matcher, and now the
    // same delivery: bodies on suggestions, an escalation on every non-answer,
    // and the same actor gate. Both numbers are hard zeros, not thresholds.
    const b = SUPPORT_EVAL_BASELINE;
    expect(b.mcp.wrong_answer).toBe(0);
    expect(b.missesWithoutEscalation.mcp).toBe(0);
  });

  it("🔴 the two channels classify every shared fixture identically", () => {
    // One brain, two adapters. A divergence here means a surface has grown a
    // second opinion about the same corpus - the exact drift this arc removed.
    const { agree, of } = SUPPORT_EVAL_BASELINE.channelAgreement;
    expect(of).toBeGreaterThan(40);
    expect(agree).toBe(of);
  });
});

describe("defect pins — a FAILURE here means a defect was fixed; flip it", () => {
  it("FIXED: rewards recovery no longer routes to DISABLING rewards", () => {
    expect(SUPPORT_EVAL_BASELINE.perFixture["rewards-recover"]?.in_app).toBe(
      "correct_answer",
    );
  });

  it("FIXED: the shipped-but-unanswerable capabilities all have entries", () => {
    for (const id of [
      "add_to_apple_calendar",
      "add_to_apple_wallet",
      "recover_rewards",
      "confirmation_email_missing",
      "change_business_type",
      "my_cancellation_policy",
      "shop_location",
    ]) {
      const cap = capabilityById(id);
      expect(cap, id).toBeDefined();
      expect(cap!.corpusIds.length, `${id} has no corpus entry`).toBeGreaterThan(0);
    }
  });

  it("FIXED: the tool's own example phrasing now returns a real answer", async () => {
    // help.ts's query description used to suggest "take a deposit", which
    // searchFeatures' strict AND semantics guaranteed would match nothing -
    // the documented usage was a guaranteed zero-result. The feature array can
    // still legitimately be empty for a phrase like this; what matters is that
    // the corpus ANSWER now carries the reply.
    const obs = await observeMcp({
      id: "pin-deposit",
      capabilityId: "refunds_deposits_howto",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "take a deposit",
      probe: "terse",
    });
    expect(obs.answerId).toBe("take-a-deposit");
    expect(obs.behavior).toBe("correct_answer");
  });

  it("FIXED: MCP suggestions carry their bodies, and an id can be redeemed", async () => {
    const obs = await observeMcp({
      id: "pin-bodies",
      capabilityId: "human_help",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "do you integrate with quickbooks",
      probe: "canonical",
    });
    expect(obs.suggestionIds.length).toBeGreaterThan(0);
    // Every suggestion, not just one: a single body among four is still a menu.
    expect(obs.suggestionsHaveBodies).toBe(true);
    // And the redemption path the web bubble always had now exists here too.
    expect(toolDefinition("help_get_answer")).toBeDefined();
  });

  it("FIXED: a total miss over MCP still hands back the route to a human", async () => {
    // The worst version of the old behaviour: on the ONE path where the
    // connector knew nothing, a four-item slice cut off `contact-human` - the
    // only entry carrying the support address.
    const obs = await observeMcp({
      id: "pin-esc",
      capabilityId: "human_help",
      actor: "mcp_user",
      channels: ["mcp"],
      question: "do you integrate with quickbooks",
      probe: "canonical",
    });
    expect(obs.escalationOffered).toBe(true);
  });
});
