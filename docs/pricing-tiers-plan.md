# ChairBack Pricing & Tier Plan (v2 — grounded financials)

**Status:** SUPERSEDED — implemented 2026-07-10 (branch feat/ai-receptionist), with deltas:

- Tiers shipped as **Free $0 / Premium $34.99 (kept, not $39) / Premium AI $74.99**
  (not $79 — with the $40 receptionist add-on retained for Premium shops,
  $74.99 = exactly pro + add-on, so pricing above that would be dominated).
  Internal plan strings: `free` / `pro` / `pro_ai` (PLANS map in
  packages/config/src/constants.ts).
- Monthly SMS quotas: Premium **600**, Premium AI **2,500**, per UTC calendar
  month, counting SENT marketing kinds only (nudge/winback/promo/receptionist
  gap-fill). **Hard stop + upgrade CTA at the quota — NO metered overage**
  (deviates from §1/§3 of this doc; overage billing can be added later).
  Enforcement: apps/api/src/billing/quota.ts.
- Receptionist replies (client-initiated) stay quota-exempt but got their own
  abuse caps (30/client/day, 200/shop/day — apps/api/src/receptionist/replyCap.ts).
- The cost model below (~$0.018/msg all-in) remains the reference for the
  quota sizing and is still current.

**Original status:** PLAN (not built). Tiered subscription model that funds SMS cost and protects margin at scale.
**Date:** 2026-06-26
**Author:** Eric + Claude
**v2 change:** all margins rebuilt on *verified June 2026 Twilio pricing* (not estimates), with a
low/expected/high sensitivity band instead of single-point guesses.

---

## 0. Verified cost inputs (June 2026 Twilio US, sourced)

| Cost | Value | Notes |
|---|---|---|
| Outbound SMS base | **$0.0083 / segment** | Twilio list price |
| Carrier surcharge (pass-through) | **~$0.003–0.005 / segment** | AT&T/T-Mobile/Verizon; raised Jan 2026 |
| **All-in per segment** | **~$0.011–0.013** | base + surcharge. **Working number: $0.012** |
| Inbound SMS (STOP/HELP replies) | ~$0.0075 / segment | minor; folded into overhead |
| Local number | ~$1.15 / mo | per number |
| A2P Campaign monthly fee | **$1.50–$10 / mo** | Low Volume Standard, use-case dependent. Assume ~$2/mo (mixed) |
| One-time: Brand reg | ~$4 | once |
| One-time: Campaign vetting | ~$15 | once |
| One-time: number reg | ~$0.50 | per number |
| Failed-message fee | $0.001 / failed msg | negligible |

**Critical correction vs v1:** I previously used **$0.01/segment**. The verified all-in is
**~$0.012** (20% higher) because the Jan 2026 carrier surcharge increases. Also: a "text" is
often **1.5 segments** (messages >160 chars split). So a realistic **cost per *message*** is:

> **~1.5 segments × $0.012 = ~$0.018 per message** (working number for all margins below).

This is the single most important number in the doc. Everything keys off **~$0.018/message** all-in.

**Sensitivity band used throughout:**
- **Low** (short msgs, 1 seg): ~$0.012/msg
- **Expected** (1.5 seg): ~$0.018/msg
- **High** (2 seg + high-surcharge carrier mix): ~$0.026/msg

---

## 1. The problem this solves

SMS is real COGS. The danger at scale is **variance, not average**: on a flat "unlimited texts"
plan, one busy shop texting 5,000/mo costs you ~$90 while a quiet shop costs ~$9 — both paying the
same. Heavy shops silently eat your margin. Fix = **tiers with an included SMS allowance + metered
overage.** Light shops cheap to serve, heavy shops pay proportionally, no shop can blow your margin.

## 2. What already exists (build ON this)

Schema (`packages/db/prisma/schema.prisma`, model `Shop`) already has the bones:
- `plan String @default("free")` — extend the allowed values.
- `dailySendCap Int @default(50)` — **already meters SMS by cost** (`nudge.ts:161` counts SENT
  marketing SMS today; loyalty/transactional + WEB_PUSH exempt). Enforcement seam for tiers.
- `compAccess Boolean @default(false)` — **your "comp test users, all free" mechanism, already
  built.** Full access regardless of Stripe, excluded from revenue counts.
- `subscriptionStatus`, `stripeCustomerId`, `stripeSubscriptionId`, `trialEndsAt` — platform
  subscription plumbing present (separate from per-barber Stripe Connect, [[chairback-payments-plan]]).
- Feature flags to gate per tier: `loyaltyTextsEnabled`, `publicPageEnabled`, native booking, etc.

So tiers = (1) define them, (2) add a **monthly** SMS counter + allowance on top of the daily cap,
(3) map features→tier, (4) wire Stripe prices. Most enforcement already exists.

---

## 3. The tiers

Four tiers (names are placeholders).

### 🆓 Free — "Loyalty Starter" · $0/mo
The hook. NO SMS (SMS is your cost center — never give it away except via comp).
- Loyalty punch cards, rewards page (/r/), basic public page (/s/), manual clients, 1 chair
- **Web push** notifications (FREE to you) for loyalty + rebooking — real value at $0 cost
- **NO SMS.** This is the deliberate line and the upgrade driver ("want to text? → Pro").
- **Comp exception:** testers/friends get Free price + Premium features + SMS via `compAccess`.

### 💈 Pro — "Growth" · $39/mo · (anchor tier)
*Raised from v1's $29 — see §5 for why the higher carrier cost demands it.*
- Everything in Free, plus **SMS enabled**
- **Included SMS: 600 msgs/mo**
- Loyalty texts, native booking + appointment reminders, 3 chairs, custom SMS template, full
  public-page styling, reviews
- **Overage: $0.05/msg** beyond 600 (you pay ~$0.018 → ~64% overage margin)

### 🏆 Premium — "Shop" · $79/mo · (busy / multi-chair)
*Raised from v1's $59.*
- Everything in Pro, plus **Included SMS: 2,500 msgs/mo**
- Unlimited chairs, promo blasts, priority support
- (Future) per-shop dedicated number ([[chairback-per-shop-numbers-plan]]) as a Premium perk
- **Overage: $0.04/msg** beyond 2,500

### 🏢 (Future) Multi-location / Enterprise · custom
Only when a real chain asks. Pooled SMS, dedicated numbers, custom pricing. Don't pre-build.

---

## 4. Tier comparison

| Feature | Free $0 | Pro $39 | Premium $79 | Comp |
|---|---|---|---|---|
| Loyalty punch cards | ✅ | ✅ | ✅ | ✅ |
| Rewards page (/r/) | ✅ | ✅ | ✅ | ✅ |
| Public page (/s/) | basic | full | full | full |
| Web push (free) | ✅ | ✅ | ✅ | ✅ |
| **SMS** | ❌ | ✅ 600/mo | ✅ 2,500/mo | ✅ (capped) |
| Loyalty texts | ❌ | ✅ | ✅ | ✅ |
| Native booking + reminders | ❌ | ✅ | ✅ | ✅ |
| Promo blasts | ❌ | ❌ | ✅ | ✅ |
| Chairs | 1 | 3 | unlimited | unlimited |
| Custom SMS template | ❌ | ✅ | ✅ | ✅ |
| Reviews | ❌ | ✅ | ✅ | ✅ |
| SMS overage | — | $0.05/msg | $0.04/msg | n/a |
| Priority support | ❌ | ❌ | ✅ | — |

---

## 5. PER-SHOP MARGIN — rebuilt on real costs, with bands

Per shop = subscription − (SMS used × $/msg) − (~$1.15 number share + ~$2 campaign share, which at
scale amortizes toward ~$0 per shop on a shared number; shown as ~$1 fixed below).

### Pro @ $39, included 600 msgs/mo

| SMS used | Low ($0.012) | Expected ($0.018) | High ($0.026) |
|---|---|---|---|
| 300 (light) | $39 − $3.6 − $1 = **$34.4** | $39 − $5.4 − $1 = **$32.6** | $39 − $7.8 − $1 = **$30.2** |
| 600 (at cap) | $39 − $7.2 − $1 = **$30.8** | $39 − $10.8 − $1 = **$27.2** | $39 − $15.6 − $1 = **$22.4** |
| 900 (300 overage @ $0.05 = +$15 rev) | **$45.8** | **$42.2** | **$37.4** |

→ Pro is **healthy across the whole band** (~$22–34 gross), and **overage makes heavy users *more*
profitable, not less** — exactly the design goal. Even worst case (at cap, high cost) = $22 gross
on $39 = 57% margin.

### Premium @ $79, included 2,500 msgs/mo

| SMS used | Low | Expected | High |
|---|---|---|---|
| 1,500 (light) | $79 − $18 − $1 = **$60** | $79 − $27 − $1 = **$51** | $79 − $39 − $1 = **$39** |
| 2,500 (at cap) | $79 − $30 − $1 = **$48** | $79 − $45 − $1 = **$33** | $79 − $65 − $1 = **$13** |
| 4,000 (1,500 overage @ $0.04 = +$60) | **$108** | **$93** | **$73** |

→ Premium is healthy except the **worst-corner case** (at full 2,500 cap AND high $0.026/msg =
only $13 gross). That corner is why the **overage rate and the cap matter**: a shop consistently
hitting 2,500 should be nudged to watch volume or it's a thin-margin account. The overage row shows
the system self-corrects — past the cap they pay $0.04 and margin recovers.

### Why prices went UP from v1 ($29→$39, $59→$79)
v1 used $0.01/msg. Real all-in is ~$0.018 (80% higher per message). At v1's $29 Pro with 500
included msgs at real cost, a shop at cap in the high band = $29 − $13 − $1 = **$15 gross (52%)** —
survivable but thin, and it leaves no room for support/infra/Stripe fees (~3%) or your own time.
$39 restores a comfortable buffer. **The carrier surcharge increase is real money; the price has
to reflect it.**

---

## 6. PLATFORM-LEVEL P&L at scale (illustrative)

Assumed mix: ~60% Pro, ~30% Premium, ~10% Free. Expected $0.018/msg. Avg usage ≈ 60% of cap.

| Shops | Paying (Pro/Prem) | SMS cost/mo | Subscription rev/mo | **Gross/mo** |
|---|---|---|---|---|
| 3 (now) | mostly comp/free | ~$60 | ~$0 | invest |
| 50 | 30 / 15 | ~$1,500 | 30×$39 + 15×$79 = **$2,355** | **~$855** |
| 100 | 60 / 30 | ~$3,000 | 60×$39 + 30×$79 = **$4,710** | **~$1,710** |
| 500 | 300 / 150 | ~$15,000 | 300×$39 + 150×$79 = **$23,550** | **~$8,550** |
| 1,000 | 600 / 300 | ~$30,000 | **$47,100** | **~$17,100** |

Plus overage revenue (not modeled above — pure upside) and Free→Pro conversions over time.
**Subscription revenue outpaces SMS cost ~1.5–1.6× at every scale** because (a) SMS isn't in Free
and (b) heavy users pay overage. The model is structurally profitable, not dependent on hoping
shops stay light.

**Caveat:** these exclude *your* other costs — Railway/Supabase hosting (~$50–500/mo across this
range), Stripe fees (~2.9%+$0.30 per charge ≈ 3% off subscription rev), and your time. Net of
those, 500 shops ≈ **~$7,500–8,000 true monthly gross.** Still strongly positive.

---

## 7. How "comp" works (your test users)

Mechanism already exists (`compAccess`):
- `compAccess = true` → Premium features + SMS, at $0, regardless of Stripe, excluded from revenue.
- **Still set a monthly cap on comped shops** (e.g. Premium's 2,500). Free-to-them ≠ unlimited cost
  to you — a tester accidentally blasting 10,000 texts is ~$180 out of your pocket. Comp = "Premium
  for free, with a safety cap."

---

## 8. The one real build: SMS metering (monthly allowance)

Today = **daily** cap. Tiers need **monthly allowance + overage**. Two phases:

### Phase 1 — MEASURE (NOW, cheap, no billing)
- Per-shop **monthly SMS counter**: count `Nudge` rows `channel="SMS" status="SENT"` bucketed by
  calendar month (mirror `nudge.ts:161`). Recommend counting **all** SMS for true cost visibility,
  even if only *marketing* counts against the *allowance*.
- Surface on dashboard ("X / 600 texts this month").
- **Why now:** can't set sane limits without real per-shop volume data. Costs nothing at 3 shops,
  and it's the input every number in §5–6 depends on. **This is the highest-leverage next step.**

### Phase 2 — ENFORCE (~10–50 shops, with data in hand)
- Derive monthly allowance from `plan` (or add `monthlySmsAllowance Int`).
- At allowance: **soft** for transactional (always send appointment reminders, bill overage via
  Stripe metered usage) + **hard-ish** for marketing (pause promo blasts, prompt upgrade). Never
  block a reminder; do pause a blast.
- Enforcement point exists: extend the budget check shared by `nudge.ts` / `promotions.ts` /
  `dashboard.ts`.

---

## 8b. Trial & on-ramp strategy (DECIDED)

A flat "14-day trial" is the reflexive SaaS answer and is **wrong for ChairBack** — value is
slow-burn: loyalty pays off as clients return over *weeks*, rebooking nudges fire on each client's
visit cadence (`rebookWindowDays` default 14), and a shop must onboard + import clients before
anything happens. A 14-day clock can expire before the shop ever *sees* the loop close → preventable
churn. So the on-ramp is layered, not a single trial:

| Audience | On-ramp | Why |
|---|---|---|
| First testers / friends / partners | **Comp** (`compAccess`, free forever, full features) | Pre-revenue: want them ON, giving feedback, building case studies. No clock. |
| Everyone, ongoing | **Free tier forever** (loyalty + rewards page + web push, NO SMS, no card) | The real no-risk on-ramp. Get hooked on loyalty, upgrade *when they want SMS*. |
| New shops trying paid | **30-day free trial of Pro** (NOT 14), **no card up front** | 30 days = enough for clients to cycle back + nudges to fire. No-card = max signups for a new product. |

**Decisions locked (2026-06-26):**
- Trial length: **30 days** on Pro (not 14 — slow-burn value needs the runway).
- Card: **no card up front** — optimize for signups now; revisit to card-required once there's
  traffic and conversion data (no-card = more trials/lower conversion; card = fewer/higher).
- The Free tier IS the primary on-ramp; the 30-day trial is specifically to let shops experience
  the **paid SMS feature** before paying.

**Guardrail — a trial/comp still sends real SMS on YOUR dime.** A trialing or comped shop blasting
5,000 texts costs *you* ~$90–180. So:
- Apply a **trial send cap** (e.g. the Pro 600/mo allowance, or lower for trials) via the existing
  `dailySendCap`/monthly-allowance seam.
- Comped shops also get a finite cap (see §7). Free-to-them ≠ unlimited cost to you.

**Plumbing:** `trialEndsAt` already exists on `Shop`. Trial = set `trialEndsAt = now + 30d`, treat
trialing shops as Pro-featured until it lapses, then fall back to Free (not lock-out — they keep the
Free tier). The Stripe webhook already keeps `subscriptionStatus`/`plan` in sync.

## 9. Sequencing

1. **NOW:** Build per-shop **monthly SMS counter** (measure-only). ← do this first.
2. **NOW:** Lock tier definitions + prices below so onboarding/marketing copy can reference them.
3. **~10–20 shops:** Wire Stripe Prices (Pro/Premium), gate features by `plan`, turn on monthly
   allowance + overage using Phase-1 data.
4. **~50+ shops:** Tune from real margin data; per-shop numbers as Premium perk.

## 10. Open decisions for Eric

- [ ] **Final prices.** $39/$79 are *cost-justified floors* given real carrier costs. Validate
      against what barbers will actually pay — but don't go below them or margin gets thin in the
      high band (see §5).
- [ ] Do loyalty/transactional texts count against the allowance, or only marketing? (Recommend:
      only marketing counts; transactional always sends; track both for cost visibility.)
- [ ] Soft overage vs hard cap (recommend soft-transactional / pause-marketing).
- [ ] Free tier: 1 chair, no SMS, no native booking (booking reminders need SMS). Confirm.
- [ ] Annual billing discount (e.g. 2 months free) — improves cash flow + retention.
- [ ] Trial: how long for Pro before card required? (`trialEndsAt` already exists.)
```
```
```
Sources for cost inputs:
- Twilio US SMS pricing: https://www.twilio.com/en-us/sms/pricing/us
- Twilio A2P 10DLC pricing & fees: https://help.twilio.com/articles/1260803965530
- T-Mobile carrier fee changes (Jan 2026): https://help.twilio.com/articles/44609260499995
```
