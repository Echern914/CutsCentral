# Go-live runbook: real SMS + real Acuity

No secrets in this file. Values you generate (SIDs, tokens, client secrets) go in
Railway Variables and DEPLOY.md (gitignored), never here.

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
   `https://chairbackapi-production.up.railway.app/webhooks/twilio/inbound`
6. Railway Variables (API service):
   - `TWILIO_ACCOUNT_SID` = ACxxxxxxxx
   - `TWILIO_AUTH_TOKEN` = (from console)
   - `TWILIO_FROM_NUMBER` = +1XXXXXXXXXX (the purchased number)
   - Leave `DRY_RUN=true` until the campaign shows APPROVED.
7. After approval: set `DRY_RUN=false`, redeploy, then verify with the checklist at
   the bottom.

### Campaign registration answers (paste these)

**Campaign description:**
ChairBack is a loyalty and rebooking tool for independent barbershops. On behalf of
a barbershop, we send its existing clients (1) occasional reminders that they are
due for their next appointment, with a booking link, and (2) occasional offers or
loyalty-program updates from that specific shop. Clients are existing customers of
the shop who provided their phone number when booking an appointment. Every message
identifies the shop and includes opt-out language. STOP is honored automatically
and permanently; START re-subscribes.

**Sample message 1 (rebooking reminder):**
Hey Marcus, it's been a while since your last cut at Dave's Barbershop! Book your
next one: https://example.com/book • Your rewards: https://example.com/r/abc123
Reply STOP to opt out.

**Sample message 2 (offer):**
Hey Marcus — Dave's Barbershop: Spring Special. 20% off any weekday cut. Show code
SPRING20. Book: https://example.com/book Reply STOP to opt out.

**How do end users consent / opt in?**
End users are existing clients of the barbershop. They provide their phone number
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
     `https://chairbackapi-production.up.railway.app/api/acuity/oauth/callback`
   - Scope: `api-v1`
2. Railway Variables (API service):
   - `ACUITY_OAUTH_CLIENT_ID` = (issued id)
   - `ACUITY_OAUTH_CLIENT_SECRET` = (issued secret)
   - `ACUITY_OAUTH_REDIRECT_URI` = `https://chairbackapi-production.up.railway.app/api/acuity/oauth/callback`
3. Redeploy the API.
4. Connect a real Acuity account through onboarding (Dashboard -> connect step) and
   watch Railway logs during the first connect, first webhook, and backfill.

### Three things to verify live on first real connect (built behind seams)

1. Does the token response include expiry/refresh? (refresh logic exists; confirm it triggers)
2. Dynamic webhook subscription endpoint shape (subscription create response/ids).
3. What HMAC key signs webhooks for OAuth apps (we also rely on the unguessable
   per-shop webhook URL, so signature ambiguity is not fatal).

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
- **Coverage for everyone else:** a manual "Log visit" button (one tap per client
  visit, earns punches via the normal engine) lets barbers on Booksy/theCut/Squire
  use ChairBack rewards with zero integration.
