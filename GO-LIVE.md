# Go-live runbook: domain + real SMS + real Acuity

No secrets in this file. Values you generate (SIDs, tokens, client secrets) go in
Railway Variables and DEPLOY.md (gitignored), never here.

Final domain: **getchairback.com** (web) and **api.getchairback.com** (API).
Do section 0 FIRST so Acuity/Twilio/Google are registered against final URLs once.

## 0) Domain wiring (getchairback.com via Namecheap)

1. Vercel -> project -> Settings -> Domains -> add `getchairback.com` AND
   `www.getchairback.com` (Vercel auto-redirects www to the apex).
2. Railway -> API service -> Settings -> Networking -> Custom Domain ->
   `api.getchairback.com`. Railway shows a CNAME target (something.up.railway.app).
3. Namecheap -> Domain List -> getchairback.com -> Advanced DNS, add exactly:
   - A Record    | Host `@`   | Value `76.76.21.21` (Vercel; confirm against what Vercel shows)
   - CNAME       | Host `www` | Value `cname.vercel-dns.com`
   - CNAME       | Host `api` | Value (the target Railway showed in step 2)
   Delete Namecheap's default parking records if present.
4. Wait for both dashboards to show the domains verified (minutes, up to an hour).
5. Env updates, SAME two values on BOTH services, then redeploy both:
   - `APP_BASE_URL=https://getchairback.com`
   - `API_BASE_URL=https://api.getchairback.com`
6. Google Cloud -> OAuth client -> Authorized redirect URIs -> ADD
   `https://api.getchairback.com/api/auth/google/callback` (keep the old Railway
   one too; config takes a minute to propagate).
7. Verify: `https://api.getchairback.com/healthz` returns ok; log in at
   `https://getchairback.com`; Google sign-in works; open a client rewards link.
   (Old vercel.app/railway.app URLs keep existing as aliases.)

## 1) Twilio + A2P 10DLC (start FIRST - approval takes days)

The code is ready: provider wired, STOP/START handled, daily caps enforced,
`DRY_RUN=true` keeps everything simulated until you flip it.

### Steps (your clicks)

1. Create a Twilio account and upgrade it (A2P registration requires a paid account).
2. Buy one local US 10DLC number (Phone Numbers -> Buy a Number).
3. Trust Hub -> A2P 10DLC:
   - Create the Customer Profile (sole proprietor works; EIN/LLC gets higher throughput).
   - Register a Brand.
   - Register a Campaign. Use case: **Low Volume Mixed** (covers both reminders and offers).
4. Paste the campaign answers below.
5. Point the number's webhook: Phone Number -> Messaging -> "A message comes in" ->
   Webhook, HTTP POST:
   `https://api.getchairback.com/webhooks/twilio/inbound`
6. Railway Variables (API service):
   - `TWILIO_ACCOUNT_SID` = ACxxxxxxxx
   - `TWILIO_AUTH_TOKEN` = (from console)
   - `TWILIO_FROM_NUMBER` = +1XXXXXXXXXX (the purchased number)
   - Leave `DRY_RUN=true` until the campaign shows APPROVED.
7. After approval: set `DRY_RUN=false`, redeploy, then verify with the checklist at
   the bottom.

### Campaign registration answers (paste these)

**Campaign description:**
ChairBack is a loyalty and rebooking tool for independent barbershops, salons, and
similar appointment-based personal-care businesses. On behalf of a shop, we send its
existing clients (1) occasional reminders that they are due for their next
appointment, with a booking link, and (2) occasional offers or loyalty-program
updates from that specific shop. Clients are existing customers of the shop who
provided their phone number when booking an appointment. Every message identifies
the shop and includes opt-out language. STOP is honored automatically and
permanently; START re-subscribes.

**Sample message 1 (rebooking reminder):**
Hey Marcus, it's been a while since your last cut at Dave's Barbershop! Book your
next one: https://daves.as.me • Your rewards: https://getchairback.com/r/abc123
Reply STOP to opt out.

**Sample message 2 (offer):**
Hey Marcus — Dave's Barbershop: Spring Special. 20% off any weekday cut. Show code
SPRING20. Book: https://daves.as.me Reply STOP to opt out.

**How do end users consent / opt in?**
End users are existing clients of the shop. They provide their phone number
directly to the shop when booking an appointment (through the shop's online booking
system) or in person at the shop, understanding the shop will contact them about
appointments and its loyalty program. Messages are sent only to clients with a
number on file who have not opted out. Volume is capped per shop per day.

**Opt-out handling:** Reply STOP at any time; the sender immediately and permanently
stops messaging that number (automated). START/YES/UNSTOP re-subscribes.

## 2) Acuity / Squarespace Scheduling OAuth

(Squarespace Scheduling IS Acuity - one registration covers shops on either name.)

### Steps (your clicks)

1. Register the app: https://acuityscheduling.com/oauth2/register
   - App name: ChairBack
   - Redirect URI (exact, no trailing slash):
     `https://api.getchairback.com/api/acuity/oauth/callback`
   - Scope: `api-v1`
2. Railway Variables (API service):
   - `ACUITY_OAUTH_CLIENT_ID` = (issued id)
   - `ACUITY_OAUTH_CLIENT_SECRET` = (issued secret)
   - `ACUITY_OAUTH_REDIRECT_URI` = `https://api.getchairback.com/api/acuity/oauth/callback`
3. Redeploy the API.
4. Connect a real Acuity account through onboarding (Dashboard -> connect step) and
   watch Railway logs during the first connect, first webhook, and backfill.

### Three things to verify live on first real connect (built behind seams)

1. Does the token response include expiry/refresh? (refresh logic exists; confirm it triggers)
2. Dynamic webhook subscription endpoint shape (subscription create response/ids).
3. What HMAC key signs webhooks for OAuth apps (we also rely on the unguessable
   per-shop webhook URL, so signature ambiguity is not fatal).

## 2.7) SMS consent via Acuity intake form (Phase B — auto-collects opt-in)

ChairBack only texts clients who have **recorded consent** (TCPA). The cleanest
way to collect it from every client is a checkbox on the barber's Acuity intake
form: when a client books and checks it, ChairBack reads that on sync and marks
them textable. No checkbox = client is imported but NOT textable until the barber
attests for them on the Clients page ("Mark consent").

### What each barber adds in Acuity (one-time, their clicks)

1. Acuity → **Client's Scheduling Page** → **Intake Form Questions** (or
   **Business Settings → Intake Form Questions**).
2. Add a question of type **Checkbox** (a single yes/no checkbox).
3. Question text (paste):
   > I agree to receive appointment reminders and rebooking texts from this
   > business. Msg & data rates may apply. Reply STOP to cancel, HELP for help.
   > Consent is not a condition of purchase.
4. Leave it **optional** (do NOT make it required — consent must be freely given,
   and a forced checkbox isn't valid consent).
5. Apply it to the appointment types that should collect consent (usually all).

### What ChairBack does with it

- On every appointment sync, ChairBack reads the appointment's `forms` answers.
- If the consent checkbox is checked, it stamps `smsConsentAt` (source
  `acuity_intake`) on that client — once; first consent wins, never overwritten,
  never auto-revoked by a later booking without it.
- Matching is by question-text substring (looks for "agree to receive" /
  "text"); the exact field name + checked-value were confirmed via the probe
  (`packages/db/prisma/probe-acuity-consent.ts`) against a real appointment.

### Verify (DRY_RUN stays true)

1. On the trial Acuity account, add the checkbox; book one test appt with it
   CHECKED and one with it UNCHECKED.
2. Reconnect (or wait for webhook) so both sync in.
3. Clients page: the checked one shows textable (no "needs consent" badge); the
   unchecked one shows "needs consent". A dry-run sweep would include only the
   consented one.

## 2.5) Stripe billing (flip revenue on any time — code is live, dormant)

The product is fully built: $29/mo "Pro" plan, 14-day free trial (starts at shop
creation; existing shops were backfilled with a fresh trial in the
`billing_industry` migration). With the three STRIPE_* vars ABSENT, billing is
disabled and everything stays free — no banner, no gating. Setting them flips on:
trial countdown banner, /dashboard/billing checkout, and a 402 gate on outbound
SMS (manual nudge, real sweep, bulk nudge, promo blast) for shops with no active
trial/subscription. Dashboards, ingest, and punch earning are never gated.

1. Stripe Dashboard -> create Product "ChairBack Pro" -> recurring price $29/month.
   Copy the `price_...` id. (If the display price ever changes, also update
   BILLING in packages/config/src/constants.ts - Stripe owns truth, config owns display.)
2. Developers -> Webhooks -> Add endpoint:
   `https://api.getchairback.com/webhooks/stripe`
   Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret (`whsec_...`).
3. Settings -> Billing -> Customer portal -> enable it (cancel + payment method
   + invoice history). The app links to it from /dashboard/billing.
4. Railway Variables (API service), then redeploy:
   - `STRIPE_SECRET_KEY` = sk_live_... (use sk_test_... + test price first if you
     want a dry run; test cards: 4242 4242 4242 4242)
   - `STRIPE_PRICE_ID` = price_...
   - `STRIPE_WEBHOOK_SECRET` = whsec_...
5. Verify: /dashboard shows the trial banner; Billing page -> Subscribe opens
   Stripe Checkout; after paying, the webhook flips the shop to Pro (banner
   disappears, "Manage billing" opens the portal).

Optional same-section: error monitoring. Create a free Sentry project (Node),
set `SENTRY_DSN` on Railway, redeploy - 500s and crashes start reporting. Unset = off.

## 2.6) Admin portal (operator-only — already built)

A founder dashboard at **/admin**: platform metrics (total shops, paying, trialing,
comped, est. MRR, new-this-week, clients/visits), a searchable list of every shop
with owner email + status, and a one-click "Comp free" toggle to grant a friend/
tester full Premium access regardless of Stripe (independent of trial/subscription,
survives Stripe going live, excluded from MRR).

Gating: session-derived `User.isAdmin` (checked server-side on every /api/admin-portal
call; non-admins get 404, logged-out get 401). There is NO self-serve way to become
admin — promote yourself once from the CLI:

  # repo root, env loaded (sign up through the app first so your user exists)
  pnpm --filter @chairback/api admin:make you@youremail.com
  # revoke with:  pnpm --filter @chairback/api admin:make you@youremail.com --revoke

After promoting, an "Admin" tab appears in your dashboard nav and /admin loads.
To comp a friend: have them sign up, find their shop in the list, click "Comp free".
(Comping works whether or not Stripe is configured.)

## 3) Post-flip verification checklist (15 minutes)

1. Add yourself as a manual client with your real phone.
2. Dashboard -> your client -> Nudge now. Text arrives, sender is the Twilio number.
3. Reply STOP. Twilio webhook fires; client shows "opted out" in dashboard.
4. Reply START. Client shows opted back in.
5. Create a live promo -> Text clients -> Preview shows 1 -> Send. Promo text arrives
   with code + STOP line.
6. Book a test appointment in the connected Acuity account; webhook ingests it;
   visit appears on the client page; completing it earns punches per your earn rules.

## 4) Other booking platforms (researched 2026-06-11)

- **Square Appointments: YES, build next.** Open Bookings API, OAuth scopes,
  `booking.created`/`booking.updated` webhooks, payloads include merchant id
  (easier multi-tenant routing than Acuity). Free tier is popular with solo barbers.
- **Booksy: no self-serve public API** (partner/contact-only). Not practical now.
- **theCut: no public API.** Not practical.
- **Squire: no public developer docs** (partner-only at best). Not practical.
- **Coverage for everyone else: SHIPPED 2026-06-12.** The "Log visit" button on
  each client page creates a real completed Visit and runs the normal earn +
  cadence pipeline, so shops on Booksy/theCut/Squire (or paper) get punches,
  at-risk radar, and nudges with zero integration. Onboarding's Acuity step says
  so explicitly, and signup has an industry picker (barber/salon/nails/lashes/
  spa/tattoo) that seeds matching defaults. Marketing: /for/salons, /for/nails,
  /for/lashes, /for/spas, /for/tattoo, /for/barbers.
