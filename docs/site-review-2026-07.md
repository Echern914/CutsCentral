# Site Review — July 2026

A full inventory of the product surface plus a prioritized list of what to add
next. Compiled 2026-07-18 from a route-by-route sweep of `apps/web`,
`apps/api`, and the notification engines. Doubles as product documentation:
the "what exists" sections are accurate as of the review date.

## Shipped from this review

| PR | What |
|---|---|
| #92 | Page tab audit fixes: Square Book CTA (missing `"square"` union + no way to set `bookingUrl`), field-level save errors, logo rendered on `/s/[slug]`, client-side slug/hex validation |
| #93 | Dedicated `/dashboard/account` page: profile avatar, connected sign-in methods, verified login-email change, per-session rate limits on account mutations |
| (this PR) | Standalone `/pricing` page (replaces the redirect), testimonials section on the landing page (placeholder quotes — **swap before running ads**), Vercel Web Analytics |

## What exists today (route map)

**Marketing / SEO**: `/` (hero, how-it-works, features, testimonials, pricing,
FAQ), `/pricing`, `/for/{barbers,salons,nails,lashes,spas,tattoo}`, `/support`,
`/terms`, `/privacy`, `/sms`, `/sms-consent`, `/accessibility`. Sitemap,
robots, OG metadata, custom 404/error pages, strong CSP all present.

**Demo**: `/demo` (client-experience tour on the demo tenant),
`/demo/dashboard` (read-only barber tour with a demo session).

**Auth**: `/login`, `/signup`, `/forgot-password`, `/reset-password`,
`/confirm-email` (new), Google OAuth web + native, Apple native (login-only per
App Store 3.1.1), `/app-auth` native handoff.

**Client-facing (token-based, no client login)**: `/s/[slug]` mini-site,
`/book/[slug]` native booking engine (staff/service/slots, add-ons, targeted
slots, Stripe/Apple Pay, waitlist), `/book/manage/[token]` (cancel, check-in,
on-my-way, nudge replies), `/r/[magicToken]` rewards PWA (punches, tiers,
wallet pass, push, consent, data deletion).

**Dashboard**: Overview (+shop SettingsCard), Insights, Clients (+detail),
Rewards, Promos, Booking, Payments, Page (site editor), Inbox (AI
receptionist), Requests, Reviews, Nudges, Billing, Activity, Leaderboard,
Account (new), Admin, CSV export. Ctrl-K feature palette (`FEATURE_INDEX`) is
the discovery surface. No orphan routes.

**Notifications** (SMS = Twilio, Email = Resend, Push = web + native):

| Event | SMS | Email | Push |
|---|---|---|---|
| Booking confirmed | ✅ | ✅ | — |
| Reminders | ✅ ~24h | ✅ ~24h | ✅ 24h + 2h |
| Punch earned / reward redeemed | ✅ | — | ✅ |
| Rebooking nudge / win-back | ✅ | — | ✅ |
| Promo blast | ✅ | — | — |
| Slot opened | ✅ barber | ✅ waitlist | ✅ both |
| Trial expiry (owner) | — | ✅ | — |
| AI receptionist | ✅ 2-way | — | — |

All SMS honor consent, quiet hours, per-shop caps, and the global `DRY_RUN`
kill switch. The codebase carries no TODO/FIXME debt; dark features are gated
by env presence (receptionist, wallet passes, email, scheduler), not dead code.

## Recommendations — prioritized

Ranked by impact-per-effort for a product whose engine (loyalty + rebooking +
native booking) is already deep, but whose top-of-funnel and client-side
relationship features are thin.

### Now / next (high impact, low-medium effort)

1. **True reschedule for clients.** "Reschedule" today is cancel-and-rebook
   (`/book/manage/[token]` links back to the booking page). An in-place move —
   pick a new slot, keep the same appointment/payment record — removes the
   single biggest friction in the client loop and cuts accidental
   cancellations. Medium effort: the slot picker and overlap guard already
   exist; needs one new endpoint + manage-page UI.
2. **Help center / knowledge base.** Support is one email address and one FAQ
   block. Even 10 short articles (connect Square, set up your page, how quotas
   work, receptionist liability, consent rules) would deflect most email and
   help SEO. Low effort to start: static `/help` section with markdown
   articles; the FAQ content and `FEATURE_INDEX` descriptions are seed
   material.
3. **OG image generation.** Public shop pages share with a generic card unless
   the shop uploaded a hero. A `opengraph-image.tsx` that renders shop name +
   accent color (and a branded one for marketing pages) makes every shared
   link look intentional — barbers share links in Instagram bios and DMs, this
   is their storefront. Low effort with Next's built-in OG image API.
4. **Swap the placeholder testimonials for real quotes** from the three live
   shops (with permission). Zero engineering; highest-credibility content on
   the landing page.

### Soon (high impact, higher effort)

5. **Referral program.** Two distinct loops, both absent:
   - *Client → client*: "give a friend their first punch, get one yourself" —
     rides the existing rewards page + punch engine, and the magic-token
     identity makes attribution easy.
   - *Shop → shop* ("give a month, get a month"): barbers talk to barbers;
     this is the cheapest acquisition channel the product could have.
6. **Blog / vertical content.** The `/for/[vertical]` landers exist but
   nothing feeds them authority. A handful of evergreen posts per vertical
   ("how much do no-shows cost a nail studio") is the standard SEO play; the
   landers already provide the conversion target.

### Later / big bets

7. **Client accounts** (cross-shop identity, "my appointments"). Today clients
   are per-shop records with token links — deliberately simple and
   TCPA-clean. A client login unlocks reschedule-anywhere, saved cards, and a
   consumer surface, but it's a architectural shift (global identity vs.
   tenant-scoped records) — only worth it when multi-shop client overlap is
   real.
8. **Revenue add-ons**: gift cards, tipping at pay-ahead, no-show fee
   automation, intake/waiver forms (tattoo/spa verticals expect these — they'd
   strengthen the multivertical story).
9. **Changelog + status page.** Cheap trust signals once there are more than a
   handful of shops; a `/changelog` also gives the nudge emails something to
   link.

### Deliberately not recommended

- **Marketplace/discovery features** — the positioning wedge is "you own your
  client list, 0% commission"; a directory would dilute it.
- **A second analytics layer** — Vercel Analytics (this PR) covers traffic and
  funnels; the Insights tab covers shop-side metrics. Revisit only if ad spend
  starts needing conversion APIs.
