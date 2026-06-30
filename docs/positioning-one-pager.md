# ChairBack — Positioning & Go-To-Market (2026-06-26)

> Grounded in [competitive-teardown.md](./competitive-teardown.md). The wedge is a **business-model conflict** the incumbents can't abandon — not a feature race.

---

## The positioning in one sentence

**ChairBack is the booking + payments + loyalty app that works for the barber instead of taxing them — you keep 100% of your revenue, you own your client list, and we never charge you for a client you already had.**

## Why this wins (and isn't "already out there")

"Someone built a booking app" ≠ "the wedge is taken." Booksy launched into a market that already had MINDBODY and Vagaro and won by being sharper for one user. The category is crowded; the **fair-to-the-barber** position is wide open, because the incumbents' revenue *depends* on the opposite:

- **Booksy** takes 30% of a new client's first visit — and keeps charging it after you turn it off (their own docs; 2026 BBB complaints).
- **Fresha** charges ~20% on clients **you recruited yourself** if they ever glanced at your Fresha page first (their own help center).
- **Vagaro's** "$24/mo" becomes real money once you add $20 texting + $100 app + add-ons.
- **Squire** double-dips your *clients* with a booking fee on top of pay-online.

They can copy our features. They can't easily stop taxing the barber — that's their P&L. **That's the moat.**

---

## Hand-to-a-shop pitch (the barber in the chair)

> *"You found these clients. You cut their hair. Why are you paying Booksy 30% of their first visit — and Fresha 20% even on the ones who book through your own Instagram?*
>
> *ChairBack: 0% commission. You keep 100%. Your money goes straight to your account — we can't freeze it. Your client list is yours, one-click export, anytime — no support ticket, no hostage. Loyalty punch-cards and appointment texts are built in, not a $20 add-on. The price you see is the price you pay.*
>
> *Switch in an afternoon — we import your clients and history, and we'll re-confirm texting consent for you so you're compliant from day one."*

**The five proof points (all verifiable against the teardown):**
1. **0% platform fee — keep 100%.** vs. Booksy 30% / Fresha 20% on *your own* clients. **And say it in dollars, not percent** — the clean competitors (Square, GlossGenius) make "flat 2.6%" sound harmless, so make the cost real: *"GlossGenius's 2.6% on every swipe means a shop doing $10k/mo in cards bleeds ~$260/mo — ~$3,100/yr — in processing forever, dwarfing their $24–48 subscription. ChairBack's 0% goes straight to your Stripe; that's money you keep."* The percentage hides the number; the number is the pitch.
2. **Your client list, one-click export, every plan.** vs. Booksy's support-ticket export.
3. **All-in price.** Texting + loyalty + app included. vs. Vagaro's à-la-carte stacking.
4. **No fees charged to your customers.** vs. Squire's client-side booking fee.
5. **SMS-native loyalty with real consent + quiet hours.** Compliant by design as A2P enforcement tightens — most incumbents bolt this on or charge for it.

## Hand-to-an-investor pitch

> **Market:** Barbershop/salon booking is large and crowded, but incumbents (Booksy, Fresha, Vagaro, Squire) monetize by **taking a cut of the barber's bookings and owning the client relationship.** That creates a durable, documented grievance — barbers feel taxed on their own customers and locked in.
>
> **Wedge:** ChairBack inverts the model — barber keeps 100%, owns and can export the client list, no marketplace commission. This is a *business-model* differentiator, not a feature, so it's hard for incumbents to copy without cannibalizing their revenue.
>
> **Why now:** A2P/TCPA enforcement is making compliant, consent-gated SMS a moat — we built consent + quiet hours in from the start while incumbents retrofit. Independent/booth-rent barbers (chair renters who *are* their own business) are the fastest-growing, worst-served segment for platforms built around shop-owner marketplaces.
>
> **Moat / defensibility:** (1) business-model conflict incumbents can't match; (2) per-metro supply density → switching costs once a barber's clients, history, and loyalty live with us; (3) one-click import/export makes us the easy *destination* off Booksy and the honest answer to "what if I want to leave" — which converts skeptics.
>
> **Honest risks:** Square Appointments is a clean, fair, well-funded competitor — we win on barber-specific depth, not on "they're predatory." And scale reliability is existential at Booksy's volume; see the scale-readiness audit — the architecture is sound, the fixes are mechanical and underway.

---

## Go-to-market: how to actually get to Booksy-scale

The teardown tells us *what* to say. The order of operations for *scaling* it:

1. **Win ONE shape of shop completely.** Booth-rent / chair-rental barbershops in one metro. The 0%-fee + "you own your clients" pitch lands hardest on chair-renters who *are* their own business. Get 20–50 shops that would be genuinely upset if ChairBack disappeared. Don't try to be Booksy-for-everyone yet.
2. **Make switching trivial — this is the real moat.** The reason shops don't leave Booksy is their client list and history live there. A one-click **"import from Acuity/Booksy/Square"** + **"we'll re-text your clients to re-confirm consent"** flow is worth more than any feature. It turns the incumbents' lock-in into *your* acquisition channel.
3. **Nail reliability before you chase volume.** At Booksy's scale, uptime is the product. The [scale-readiness audit](./scale-readiness-audit.md) shows the #1 risk (DB pool) is already closed; the remaining mechanical fix is a job queue so you can scale horizontally without double-texting. Good news: the hard architecture is already right.
4. **Earn marketplace density per metro, then turn on discovery.** Booksy's discovery marketplace only matters once supply is dense. Don't build discovery until you own enough local supply that it's useful — and even then, **do it without a new-client commission**, because *not* charging that fee is the whole pitch.

## Lines NOT to use (they collapse under scrutiny)

- ❌ "We're merchant of record / no SSN needed." Every payment platform does KYC — you do too. Frame funds-control as *no arbitrary freezes*, not *no verification*.
- ❌ Attacking Square **or GlossGenius** on fairness. Both are genuinely clean (no marketplace commission). Beat them on **processing economics ($ not %), included-vs-metered SMS, and barber-specific depth** — never on "they steal your clients."
- ❌ Claiming GlossGenius "has no AI" or is behind on AI. Their Growth + Marketing agents are live; only their *Reception* agent is coming-soon. The honest, durable line is **AI readiness on the reception/win-back side**, plus our economics — not "they don't have AI."
- ❌ Quoting exact competitor processing rates as gospel — several are stale/contested (see [DIRECTIONAL] tags in the teardown). Quote the *shape* ("they take a cut of new clients"), verify any precise % before print.

---
*Positioning derived from verified competitive findings. Pitch claims map 1:1 to [CONFIRMED] items in the teardown.*
