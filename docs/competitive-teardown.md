# ChairBack — Competitive Teardown (2026-06-26)

> Booksy · Fresha · Square Appointments · Vagaro · Squire
> Built from a deep-research run (104 agents, 22 sources fetched, claims adversarially verified). **[CONFIRMED]** = survived verification against the vendor's own docs or named reviews → safe to quote. **[DIRECTIONAL]** = the exact figure was contested/stale but the shape is real → don't quote the precise number.

---

## The one thing to take away

The market is crowded, but the incumbents share a **structural** weakness that is documented in their *own* help centers and fresh 2026 complaints: **they monetize the barber's own customer relationships and lock in the client list.** That is the wedge. It is more defensible than "we have booking + payments + loyalty," because features get copied and this is a *business-model* conflict the incumbents can't easily abandon — it's their revenue.

A caveat that sharpens the pitch: **don't over-claim on "barber is merchant of record."** The SSN/ID friction barbers gripe about (e.g. at Squire) is universal KYC — *you have to do it too.* Position around **control of funds and no arbitrary freezes**, not verification.

---

## Per-competitor

### Booksy — the marketplace-commission incumbent
- **Pricing [CONFIRMED]:** $29.99/mo base + $20/mo per extra staff. Five-person shop = ~$110/mo.
- **The cut [CONFIRMED, from Booksy's own Boost docs]:** "Boost" charges **30% of a new client's first visit** ($10 min, $100 max). And it's a **"sticky charge"** — it still bills you on bookings attributed while Boost was on, **even after you turn Boost off.** A 2026 BBB complaint: *"$51 fee for a service that I no longer had active."*
- **Processing [CONFIRMED]:** 2.49% + $0.10 (reader), 2.69% + $0.30 (keyed/card-on-file/deposits).
- **No-show [CONFIRMED]:** Booksy holds the card-on-file and *"collects Cancellation Fees for you"* — i.e. Booksy sits in the flow.
- **Client list [CONFIRMED]:** you retrieve it by **emailing support** (info.us@booksy.com) or in-app chat. (A plan-gated self-service CSV may also exist — the "no export at all" claim was too strong — but the practical friction is real.)
- **Payouts [CONFIRMED, pattern]:** Booksy **can freeze accounts and withhold payouts.** BBB (02/2026): *"Booksy placed a lock on my account and froze my payouts without notifying me."*
- **Top complaints [CONFIRMED]:** the sticky Boost charge; unauthorized client rerouting; frozen payouts / weak support.

### Fresha — "free" that taxes your own clients
- **The cut [CONFIRMED, from Fresha's own help center]:** a one-time **Marketplace new-client fee** (~20%, ~$6 min) when a new client books.
- **The damning part [CONFIRMED, near-verbatim from Fresha]:** the fee triggers **even when the client books through your OWN website or social media** — if they *"view your Fresha marketplace profile first and then choose to book through another online channel."* Barbers report paying 20% on clients **they personally recruited.** This is the single cleanest attack surface in the whole market.
- **Complaints [CONFIRMED]:** the cross-channel fee is widely felt as a hidden, unfair cost (practitioner blogs, barber FB groups, 2026).

### Square Appointments — the clean one (respect it)
- **The cut:** **none alleged.** Square is the *only* one of the five with no marketplace/new-client commission in the data. Its model is processing + subscription, business-configured.
- **No-show [CONFIRMED]:** genuinely flexible — three prepayment modes (none / full prepay / hold card) and no-show fees as flat-per-appt, flat-per-service, or % of price, all set by the business.
- **Read:** Square is the hardest to attack on fairness. You beat Square on **barber-specific depth** (loyalty/punch-cards, barber-native UX, per-chair booth-rent flows), not on "they take a cut." Don't pretend Square is predatory — it isn't.

### Vagaro — cheap headline, expensive reality
- **Pricing [CONFIRMED]:** ~$30/mo base (+$10/staff, +$10/location). **[DIRECTIONAL]** effective entry ~$24 promo; plateaus ~$84/mo at 7+ staff.
- **The real cost [CONFIRMED, incl. Vagaro's own docs]:** the cheap base balloons with à-la-carte add-ons — **Text Marketing ~$20/mo, Forms ~$10, website ~$20, online store $10, Branded App $100/mo.** The advertised price is misleading for any real shop.
- **Processing [CONFIRMED]:** keyed/online **3.5% + $0.15** (higher than in-person); large merchants (>~$4k/mo) 2.2% + $0.19 + $10/mo. **[DIRECTIONAL]** small-merchant in-person ~2.6–2.75% (genuinely unresolved — Vagaro changed it over time).

### Squire — barber-specific, but "double dips" the client
- **Pricing [CONFIRMED]:** four tiers $30 / $50 / $150 / $250/mo. (**[DIRECTIONAL]** a "$100–$250 personal-app fee" was refuted — the app is bundled into Titan, not surcharged.)
- **The cut [CONFIRMED, named reviews]:** Squire pushes clients to pay online **and** adds a **client-facing booking fee** — reviewers call it *"double dipping… my clients are not happy being asked for a credit card to book and then charged extra for doing so."*
- **Refuted — do NOT use these against Squire:** "mandates online payment even for cash-only" (cash is supported); "withholds payout via SSN" (that's universal KYC, you do it too). The teardown explicitly flags these as arguments that collapse under scrutiny.

### GlossGenius — the clean, AI-forward generalist (treat like Square)
> Added 2026-06-29. Verified against glossgenius.com/pricing + an independent breakdown, then adversarially fact-checked. **This competitor is CLEAN on the fairness wedge — do NOT attack it on commission.**

- **Pricing [CONFIRMED]:** three Beauty & Wellness tiers — **Standard $24/mo, Gold $48/mo, Platinum $148/mo** (annual; ~14% over monthly: $28 / $56 / $168). Separate Medspa line: Practice Essentials $148, Practice Advanced $248/mo annual. **No free plan** — $24/mo floor. Standard is **solo-only**; multi-staff starts at Gold ($48); unlimited staff is Platinum ($148).
- **The cut [CONFIRMED — there is NONE]:** **No marketplace, no new-client commission, no per-booking fee.** Pure SaaS subscription + flat processing. Their own comparison content positions *against* marketplace commissions. This was the most important thing to get right and it survived adversarial verification against two sources — **the Booksy/Fresha fairness attack does NOT land here. Same trap as Square: don't pretend they're predatory.**
- **Processing [CONFIRMED]:** **flat 2.6% on every card transaction** (tap / chip / swipe / online) with no per-transaction add-on — leaner than Square's 2.6%+$0.10. But it's **2.6% on every swipe with no free-processing path** — that's the seam. Free same-day payouts Mon–Thu; **instant payout costs an extra 1.8%.** BNPL is 6%+$0.30. Free Tap & Go reader bundled; Pro reader ~$299.
- **SMS [CONFIRMED]:** **metered marketing credits, not unlimited** — 1 credit/text, **3 credits per image** message. Caps: **Standard 500/mo, Gold 2,500/mo, Platinum 2,500/mo** — the cap **does not increase from Gold → Platinum** (both stop at 2,500). Overage = buy more in-app; **the overage price is not publicly published** (gated behind the in-app purchase flow — don't quote a number). Transactional texts (reminders/confirmations) are *not* metered.
- **AI "Agents" [CONFIRMED]:** **Growth Agent / Growth Analyst** (LIVE) — 24/7 assistant that surfaces revenue opportunities and benchmarks you against 100k+ businesses; query-gated (Standard trial / Gold 20-a-month / Platinum unlimited). **Marketing Agent** (LIVE) — drafts email+SMS campaigns. **Reception Agent** (**"Coming soon" per their own pricing page**, despite present-tense homepage copy) — answers calls/texts to book. This is their headline 2026 push and the category ChairBack has nothing for yet.
- **Read:** GlossGenius is the **modern, polished, AI-forward generalist** — the most direct product analog to what ChairBack is becoming, and a brand/onboarding benchmark (free white-glove migration, no-login client booking, website builder, Reserve-with-Google). You beat it on **economics and depth, never on fairness**: (1) **0% processing vs. their 2.6%-forever** — a hard-dollar story they structurally can't match; (2) **included SMS vs. their metered/capped credits with opaque overage** — and their cap doesn't even scale past Gold; (3) **one simple $34.99 tier** vs. their $24→$148 ladder that gates multi-staff and full AI; (4) **barber-native depth** vs. a salon/medspa-skinned generalist; (5) AI **readiness** — their flagship Reception Agent is *coming-soon*, so a working win-back/rebooking agent is a credible "ours works today" line. **Do NOT** claim they lack AI (Growth + Marketing are live) or imply any client commission (there is none).

---

## The wedge, ranked by how well-evidenced it is

1. **No commission on your own clients.** Directly attacks Booksy Boost's sticky 30% and Fresha's cross-channel 20% — both confirmed from the vendors' own docs and 2026 complaints. *"We never charge you for a client you already had."*
2. **Honest all-in pricing.** One price includes texting, loyalty, site, app. Attacks Vagaro's add-on stacking. *"The price you see is the price you pay."*
3. **One-click client-list export, every plan, no support ticket.** Attacks Booksy's support-mediated export and the general lock-in. *"Your list. Download it anytime. We can't hold it hostage."*
4. **No client-side booking fees.** Attacks Squire's double-dip. *"We never tax your customers to book with you."*
5. **Your money, no arbitrary freezes.** Attacks Booksy's payout locks — but frame it as *control of funds*, NOT as KYC/merchant-of-record (that argument is universal and collapses).

**Where NOT to fight:** **Square *and* GlossGenius on fairness** (both are clean — no marketplace commission; attack them on processing economics, SMS metering, price, and barber depth instead); "we're merchant of record / no SSN" (every platform does KYC). These read as naive to anyone who knows the space.

---
*All [CONFIRMED] items survived adversarial verification against primary sources or named reviews. [DIRECTIONAL] items are real in shape but the exact figure is contested — verify before putting a specific number in marketing.*
