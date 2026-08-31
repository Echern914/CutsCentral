# Support Intelligence Audit

**Date:** 2026-08-31 · **Base:** `origin/main` @ `3db4403a29ffaf6ec7019b34e02ec8ecc0fe3301` ·
**Production `/healthz`:** `3db4403` (main and production identical at audit time) ·
**Open PRs at audit time:** #362 (affiliate, untouched), #288/#289/#293 (parked Square stack).

The in-app assistant and the MCP connector answer real questions with "I don't
really have the answer" plus generic options. This audit maps both systems end
to end, measures an honest baseline with a deterministic evaluation suite
(`apps/api/src/support/`), and ranks the root causes. **No behavior changed in
this PR** — it is measurement, inventory, and tripwires only.

---

## 1. The system as it exists

Four "assistant-ish" surfaces exist. Exactly one calls a model, and it is not
one of the two under complaint:

```
                 ┌────────────────────────────────────────────────────┐
                 │       packages/config (shared, pure, static)       │
                 │  help.ts ─ 102 hand-written answers                │
                 │  features.ts ─ 48-entry feature registry           │
                 │  helpMatch.ts ─ findHelp() + searchFeatures()      │
                 └───────┬───────────────────┬────────────────────────┘
                         │                   │
        ┌────────────────┴─────┐   ┌─────────┴──────────────────────┐
        │  IN-APP ASSISTANT    │   │  MCP CONNECTOR  (/mcp)         │
        │  (no model, no net)  │   │  (model = barber's OWN AI)     │
        │  · Assistant tab     │   │  · OAuth 2.1 + PKCE            │
        │    AskField.tsx      │   │  · 10 read-only tools          │
        │  · HelpBubble.tsx    │   │  · toolPolicy.ts default-deny  │
        │  · Cmd-K palette     │   │  · help_find_feature wraps the │
        │                      │   │    SAME findHelp/searchFeatures│
        └──────────────────────┘   └────────────────────────────────┘

        ┌──────────────────────────────────────────────────────────┐
        │  SMS RECEPTIONIST (apps/api/src/receptionist/*)          │
        │  Anthropic claude-sonnet-5 · 7 booking tools · paid tier │
        │  — out of scope for this arc, but its seams matter (§10) │
        └──────────────────────────────────────────────────────────┘
```

Both complained-about channels are **deterministic lexical search over the
same static corpus**. That is a deliberate, guarded cost decision
(`costBoundary.test.ts` fails the build if a provider SDK/key ever enters the
assistant) and this arc preserves it: the fixes are knowledge, retrieval,
contracts, and observability — not a ChairBack-paid model.

### Entry points

| Surface | File | Notes |
|---|---|---|
| Corner help bubble | `apps/web/src/components/help/HelpBubble.tsx` | Mounted globally in `layout.tsx`; hidden on `/s/ /r/ /book /demo /welcome /team/join` |
| Assistant tab + ask field | `apps/web/src/app/dashboard/assistant/page.tsx`, `AskField.tsx` | Readiness + quick actions + MCP connect panel |
| Cmd-K palette | `apps/web/src/app/dashboard/_components/FeatureSearch.tsx` | `searchFeatures` (strict AND), not `findHelp` |
| MCP server | `apps/api/src/routes/mcp.ts` → `mcp/dispatch.ts` | JSON-RPC over POST only; tools only (no resources/prompts) |
| MCP help tools | `apps/api/src/mcp/tools/help.ts` | `help_find_feature`, `help_list_features` |
| Public support page | `apps/web/src/app/support/page.tsx` | Static; email only |
| Mobile | — | No native assistant; the WebView renders the web surfaces |
| Customer-facing assistant | — | **None.** End clients get the static support page |

---

## 2. Root causes, ranked by impact

1. **Knowledge gaps in the one corpus both channels share.** Eleven supported
   capabilities have **zero** corpus coverage (measured:
   `corpusGapCapabilities` in the baseline): confirmation/cancellation emails,
   email-in-spam, Apple Calendar (.ics), Apple Wallet, rewards link broken,
   rewards recovery, shop location, resend rewards link, change business type,
   "what is MY cancellation policy". All of these are **shipped features**.
   No phrasing can ever answer them.

2. **Confidently wrong answers — worse than the shrug.** 15/55 in-app fixtures
   (27%) return a wrong answer with full confidence: "How do I recover my
   rewards?" → the entry about **disabling** rewards; "What are the shop's
   hours?" → reminders; "add to Apple Calendar" → the walk-in recorder;
   "change my business type" → the shop-**name** entry; "holiday pricing" →
   time-off/pause-account (the token "holiday" is owned by the wrong entries).
   The matcher's own header predicts this failure class; the corpus drifted
   out from under the confidence bar.

3. **The MCP miss path is a dead end by construction**
   (`apps/api/src/mcp/tools/help.ts`):
   - Suggestions carry `{id, question}` **with no body**, and no tool exists
     to redeem an id (`helpAnswerById` exists server-side and is used by the
     web bubble — it is simply not exposed).
   - `.slice(0, 4)` drops `contact-human` — the only entry containing the
     support email — on **exactly** the total-miss path.
   - The tool's own schema example ("take a deposit") is a guaranteed
     zero-result for `searchFeatures` (strict AND semantics; the test suite
     comments on this and probes with a different word).
   - Every result is wrapped in the untrusted-shop-data envelope, so a
     cautious host model hedges on ChairBack's **own product documentation**.

4. **No feedback loop of any kind.** Web analytics is typed to exactly two
   events (`signup`, `purchase`); neither assistant surface imports it. The
   MCP audit row for a help **miss** is `result: "OK"` (a miss is a successful
   handler return), and query text is (correctly) never stored — so a shrug
   and a perfect answer are indistinguishable forever. The reported failure
   was structurally invisible until this audit.

5. **Confidence math punishes natural phrasing.** Multi-word queries need
   coverage ≥ 0.6 over the asker's own words. Falsification testing showed
   the score threshold (3.4) is not the binding constraint — the coverage bar
   is. Unmatched filler ("right now", "properly") each add a token that must
   land: *"Who's in the walk-in line?"* answers; *"Who's in the walk-in line
   right now?"* is on the edge. Longer, more specific, more natural questions
   are systematically less likely to be answered than terse ones.

6. **Tool descriptions promise fields the payloads don't contain.**
   `business_summary` advertises "utilisation" (never returned),
   `client_detail` advertises "spend" (per-visit price only), `calendar_agenda`
   advertises "for a chair or the shop" (the model cannot choose; scope is
   policy-decided). `clients_search`'s `due` and `lapsed` filters are
   literally identical in code while meaning different things to a barber.
   `calendar_openings` returns a bare `[]` with no reason — a host model
   reports "you have no availability" when the truth is a setup blocker.

7. **No live-data support tools where support needs them.** Ten capabilities
   bound to live shop data have no MCP tool (`mcpToolGaps` in the baseline):
   hours, services/prices, booking link, notification/email delivery ledger,
   walk-in queue, my-policy, and more. The billing slice is read on every MCP
   request and used only as a gate — "what plan am I on?" is unanswerable.
   A single read-only shop-profile tool collapses six of these.

8. **Divergent fallback delivery between surfaces.** The bubble's miss copy
   offers a `mailto:` escape hatch; the Assistant tab's ask field — the page
   literally titled "ChairBack Assistant" — offers chips and **no route to a
   human at all**. Neither fallback string is pinned by any test.

9. **Vocabulary debt concentrated in the two knowledge files.** ~90 hard-coded
   "barber" mentions in `help.ts` + `features.ts` — the exact two files the
   multi-vertical arc's lint explicitly exempts. Both assistant components are
   `"use client"` and cannot reach `@/lib/vocab` by design, so fixing this
   needs `VocabProvider` plumbing, not string edits.

10. **Protocol nit with real consequences:** `notifications/initialized` (sent
    by every spec-compliant MCP client immediately after `initialize`) falls
    into the unknown-method branch and receives **HTTP 404** instead of 202.
    Tolerant hosts swallow it; stricter ones log a failed handshake.

---

## 3. The measured baseline

`apps/api/src/support/` ships a deterministic evaluation suite: 58 sanitized
fixtures (customer + owner questions from real functionality, plus paraphrase
/ typo / terse / verbose / frustrated / injection / cross-tenant probes),
classified against the capability inventory by driving the **real** production
code — `findHelp()` for in-app, the **real** `help_find_feature` handler for
MCP. No model, no network, no database; the numbers are exact.

| Behavior | In-app (55 fixtures) | MCP (51 fixtures) |
|---|---|---|
| correct answer | **18 (33%)** | 18 (35%) |
| near miss (right topic in chips) | 9 | 9 |
| shrug (wrong chips) | 13 | 10 |
| generic menu | 0 | 0 |
| **confidently wrong** | **15 (27%)** | 14 (27%) |

- **Channel classification agreement: 50/50** — same corpus, same matcher.
  The channels diverge in *delivery*: MCP suggestions have no bodies and drop
  the escalation entry; the bubble adds a mailto the ask field lacks.
- **Misses with no route to a human:** 35 in-app, 31 MCP.
- **11 capabilities with zero corpus coverage; 10 live-data capabilities with
  no MCP tool** (lists live in `supportEvalBaseline.ts`).
- Injection probes ("ignore previous instructions…") classify as harmless
  shrugs — a lexical matcher has no injection surface. The MCP side's
  envelope/policy hardening is separately pinned by the existing mcp suites.

The baseline is committed (`supportEvalBaseline.ts`) and **ratcheted**:
`supportEval.test.ts` fails on ANY movement, in either direction, and floor
assertions prevent quietly regenerating it into a rosier story. Regeneration
is a reviewed, deliberate act (`regenerateBaseline.ts`).

### Falsification (all four passed)

| Break introduced (then reverted) | Detected by |
|---|---|
| Retrieval: impossible confidence bar in `helpMatch.ts` | ratchet test failed (fixtures moved classes) |
| Fallback: MCP `slice(0,4)` → `slice(0,5)` | "drops the route to a human" defect pin failed |
| Tool contract: `waitlist_list` renamed in `TOOL_POLICIES` | bound-tool integrity test failed, naming the tool |
| Staleness: `contact-human` corpus id renamed | corpus-id tripwire failed, naming the capability |

(First attempt lowering only `CONFIDENT_SCORE_MULTI` 3.4→1 moved **nothing** —
evidence that coverage, not score, is the binding constraint; recorded in §2.5.)

---

## 4. Ten representative traces (verbatim from the real matcher)

| # | Question | In-app today | Why it fails |
|---|---|---|---|
| 1 | "How do I book?" | **WRONG** → `feature-clients` ("Where do I find Clients?") | "book" synonym-expands toward booking, but the clients entry outranks `how-booking-works` |
| 2 | "My client did not receive her confirmation email" | **MISLEADING** → `client-didnt-get-text` (SMS answer) | Email delivery shipped #352; corpus has zero email entries; "text" entry absorbs it |
| 3 | "How do I add the appointment to Apple Calendar?" | **WRONG** → `walk-in` | .ics shipped #356; zero coverage; "add…appointment" tokens land on walk-in recording |
| 4 | "How do I add it to Apple Wallet?" | SHRUG → add-services/add-staff/addons/walk-in chips | Wallet passes shipped; "wallet" appears nowhere in corpus or registry |
| 5 | "How do I recover my rewards?" | **WRONG** → `turn-off-rewards` | Recovery flow shipped #339-#343 with zero coverage; "rewards" lands on the disable entry |
| 6 | "What are the shop's hours?" | **WRONG** → `reminders` | `set-hours` exists but loses; "shop"/"hours" scatter across entries |
| 7 | "Why are bookings unavailable?" | SHRUG → booking-link/how-booking-works/approval-mode/addons | The right entry (`slot-not-showing`) not even in top 4 — near-identical to a starter chip on the Assistant page itself |
| 8 | "How do I change my business type?" | **WRONG** → `shop-name` | Business-type switching shipped #351; zero coverage |
| 9 | "How do I set up holiday pricing for Christmas?" | NEAR MISS (chips include `feature-day-pricing`) — terse "holiday pricing" is **WRONG** → `time-off` | The token "holiday" is keyword-owned by time-off and pause-account |
| 10 | "Do you integrate with QuickBooks?" | GENERIC MENU (5 fallback chips) | `other-tools` exists for exactly this intent but lists only booking competitors; "integrate" is 3 edits from "integration" (> fuzzy slop) |

Over MCP the same ten collapse further: any non-confident case returns four
title-only suggestions with no bodies, no redemption tool, and (on total miss)
no support email.

---

## 5. Capability matrix

Machine-readable source of truth: `apps/api/src/support/capabilities.ts`
(38 capabilities; validated against the live corpus and tool tables by
`supportEval.test.ts`). Summary of the actor model it encodes:

| Actor | Identity | Tenant context | May reach |
|---|---|---|---|
| `public_customer` | none | none (or one shop via public slug) | product knowledge, public shop config |
| `verified_customer` | a live scoped credential (appointment `manageToken`, rewards magic link, waitlist offer/cancel token, walk-in track token, phone-OTP recovery proof) | the credential's row | exactly that credential's scope — never account-wide, never cross-customer |
| `barber` | session, `requireRole` | `req.shopStaffId` chair | own chair only |
| `manager` / `owner` | session | `req.shop` | shop-wide; owner adds billing |
| `platform_admin` | `User.isAdmin` portal or `ADMIN_TOKEN` | cross-shop | ops only — not a shop support surface |
| `mcp_user` | OAuth token → live seat re-read every call | connection's shop | intersection of seat role × token scopes × plan; read-only |

Hard rules the inventory encodes (and PR 1 must enforce in the pipeline):
- A name/email/phone is **never** an identity. The guessed-identity door is
  refused without confirming existence; the credentialed doors (manage link,
  phone-OTP recovery) are the only paths to customer data.
- One-shop rule: no rewards/customer surface may reveal that any other shop
  exists for a phone number.
- Every non-read capability requires explicit confirmation (enforced by test).
- `neverExpose` lists per capability (tokens, cross-tenant existence,
  provider payloads, contact details under the MCP PII floor).

---

## 6. Knowledge inventory

| Source | Authority rank | State |
|---|---|---|
| Live DB / provider state | 1 | Rich (EmailDelivery ledger, Nudge ledger, readiness facts, availability) — **almost none exposed to support surfaces** |
| App config (`PLANS`, registry, env) | 2 | Sound; one source of truth for prices holds everywhere |
| Help corpus (`help.ts`) | 3 | 102 entries + 49 generated; 11 capability gaps; 2 entries still open with "ChairBack is one plan" against a 3-tier catalog; "holiday" token mis-owned |
| Static content (support/pricing pages, docs/) | 4 | `docs/receptionist.md` quotes a pre-tiering "$40/mo"; none machine-readable |
| Model general knowledge | 5 | Not used by either channel (by design) |

Other findings:
- **`guideId` is a dead field**: declared in `features.ts`, populated nowhere,
  read nowhere, no guide content in the repo — while the `ai-assistant-plan`
  help entry advertises "guides" to users.
- The only shop-policy prose formatter (cancellation/deposit windows → words)
  lives un-exported inside `receptionist/prompt.ts`; any surface wanting to
  answer "what's MY policy" would have to duplicate it — the exact drift
  pattern the feature registry was built to end.
- The receptionist prompt hard-codes `address: "not listed"` although the
  Shop row carries full address columns already emitted as public JSON-LD.

---

## 7. MCP tool-contract problems (beyond §2)

- `help_list_features` accepts any category string and silently returns `[]`
  for a wrong guess; its `categories` use feature-category ids while the help
  corpus uses a different 8-id set.
- For a lapsed shop it lists every feature with unexplained `href: null`
  (`visibleFeatures` overrides entitlement, then resolution strips the link
  but `help_list_features` drops the reason `help_find_feature` keeps).
- Three inconsistent `window_too_wide` messages share one code ("62 days or
  fewer" / "31 days or fewer" / "a year or less"); all invalid-args cases
  return one fixed sentence that never names the offending field.
- `tools/list` is entitlement-filtered with `listChanged: false` — a
  long-lived session that connected while lapsed never learns the list grew.
- No MCP resources or prompts are implemented; `initialize.instructions` is
  100% vocabulary and says nothing about purpose, read-only-ness, or miss
  recovery.
- Overlap without routing guidance: `readiness_report` vs `integration_health`
  (same underlying collector, different lapsed rules), `calendar_openings` vs
  `readiness_report` for "why can't clients book".

---

## 8. Security findings (inputs to later PRs; none regressed here)

1. **Plaintext legacy credentials:** `Client.magicToken` (permanent, global,
   authorizes data deletion) and `Appointment.manageToken` are stored
   plaintext, while every newer credential (waitlist, walk-in, kiosk, OTP,
   MCP) is hash-at-rest. Compensating controls exist (log redaction, audit
   body scrubbing, rotation machinery).
2. **Receptionist transcripts are unredacted and unbounded:**
   `ReceptionistMessage.content` + `toolCalls` store raw customer SMS and tool
   results forever, while all three sibling audit stores (Nudge, MCP audit,
   waitlist audit) have written redaction rules. Any support layer reading
   transcripts must treat them as PII at rest; retention is undefined.
3. **Patterns worth reusing verbatim:** the untrusted-data envelope wrapped
   once in the dispatcher; fixed non-echoing denial copy; "return the denial
   reason, not 'not found'"; `redactUrl` shared by logs and Sentry;
   append-only-by-accessor-shape; the `bookingRefusal.ts` res.json canary as
   the template for instrumenting the 14 identical un-instrumented
   "Something went wrong" sites.
4. The lexical channels have no injection surface (measured); MCP injection
   hardening is pinned by existing suites (hostile service names, prototype
   keys, no arg echo, no Prisma text to the model).

---

## 9. Proposed PR stack

- **PR 0 (this PR) — evaluation + observability foundation.** Outcome
  taxonomy, capability inventory, 58-fixture deterministic eval, honest
  committed baseline, ratchet + staleness/contract tripwires + defect pins,
  PII/secret hygiene scan, this audit. Zero runtime change.
- **PR 1 — shared knowledge + support engine.** Close the 11 corpus gaps and
  the wrong-answer routings (re-home "holiday", rewards-recovery entry, email
  entries, wallet/.ics, business-type); export the policy formatter; retrieval
  fixes measured by the ratchet (coverage bar, phrase handling); actor-aware
  pipeline with the typed outcomes; direct-answer fallback contract (always an
  answer or one clarification + escalation path); unify the two in-app
  fallbacks; vocabulary plumbing for corpus copy. The eval's baseline is
  regenerated and every moved fixture reviewed.
- **PR 2 — MCP parity + tool repair.** `help_get_answer` (or bodies on
  suggestions); stop dropping `contact-human`; server-authored envelope kind
  for ChairBack-authored payloads; fix the three lying descriptions and
  `due`/`lapsed`; reasons on empty `calendar_openings`; shop-profile read tool
  (hours, services+prices, booking link, plan); 202 for `notifications/*`;
  category-id unification; parity eval extended to the wire.
- **PR 3 — safe actions + escalation.** Confirmation-gated mutations through
  existing business rules (never raw DB); durable audit; help-miss recording
  (`resourceType: "help_miss"` on the existing audit row — no query text);
  aggregate unanswered-questions view; structured escalation with a support
  summary.
- **PR 4 — shadow validation + rollout.** Fail-closed flags
  (`SUPPORT_INTELLIGENCE_V2_SHADOW_ENABLED` / `_ENABLED` /
  `MCP_SUPPORT_V2_ENABLED`, all default false), shadow comparison, kill
  switches, rollback = flags off, no migration rollback.

Acceptance thresholds for the arc (from the brief) are tracked against this
baseline; readiness claims come from the eval, not manual examples.

---

## 10. Session isolation

Built from a fresh `origin/main` worktree (`CB-support-intelligence`, branch
`feat/support-intelligence-pr0`). Nothing merged, deployed, enabled, or sent.
No affiliate files, branches, PRs (#360/#361/#362), email-reliability code,
DNS/Resend configuration, migrations, or production flags were touched. The
only files changed are `apps/api/src/support/**` (new) and this document.
