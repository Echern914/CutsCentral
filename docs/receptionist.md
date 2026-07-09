# AI Receptionist

The AI receptionist answers a shop's inbound texts, books/moves/cancels
appointments against the **native booking engine** (the real calendar, never a
guess), and proactively refills freed slots. It is a paid add-on (~$40/mo)
anchored on per-shop entitlement.

## How it works

```
client texts the shared Twilio number
  └─ POST /webhooks/twilio/inbound            (STOP/START handled first, unchanged)
       └─ ACK empty TwiML immediately, then async:
          receptionist/inbound.ts
            ├─ route the phone -> shop (live thread wins, else known client
            │  at a receptionist-enabled native shop, most-recent visit)
            ├─ render ai/receptionist-prompt.md with the shop's config
            ├─ rebuild thread history from ReceptionistMessage rows
            └─ agent.ts: Anthropic tool-use loop (claude-sonnet-5)
                 └─ tools.ts -> the REAL engine
                      check_availability -> engines/slots.ts
                      hold_slot/book_appointment/reschedule -> engines/bookingWrite.ts guard
                      cancel -> cancelAppointment (fires slot-opened -> gap-fill)
                      get_client_history / escalate_to_human
            reply goes out via getMessageProvider() + a Nudge ledger row
```

Proactive **gap-fill** (`receptionist/gapfill.ts`): every cancellation/no-show
already fires `notifySlotOpened`; when the receptionist is enabled it takes
over customer outreach — picks ONE candidate (loyalty-due → overdue-by-cadence
→ waitlist), places a 60-minute hold on the freed slot, and sends ONE
model-composed offer. No reply → the hold lapses silently (the hold sweep never
fires slot-opened, so there is no offer loop).

## The prompt file owns the voice

`ai/receptionist-prompt.md` (repo root) is loaded **at runtime** (mtime-cached,
`RECEPTIONIST_PROMPT_PATH` overrides the location). Edit the file, and the next
turn uses it — no deploy needed on the same box. `{{PLACEHOLDERS}}` are filled
per shop from the DB:

| Placeholder | Source |
|---|---|
| `{{SHOP_NAME}}` / `{{TIMEZONE}}` | `Shop.name` / `Shop.timezone` |
| `{{BARBER_NAMES}}` / `{{OTHER_BARBER}}` | active `Staff` rows |
| `{{HOURS}}` | `AvailabilityRule` (fallback `Shop.hoursText`) |
| `{{SERVICE_MENU}}` | active `Service` + `ServiceAddOn` rows |
| `{{BOOKING_URL}}` | `APP_BASE_URL/book/{slug}` |
| `{{DEPOSIT_POLICY}}` | `Shop.paymentsMode` |
| `{{CANCELLATION_POLICY}}` | `Shop.cancelWindowHours` / `cancelFeeBps` |
| `{{TONE}}` | `Shop.receptionistTone` |

## Tools (names match the prompt file exactly)

| Tool | Backed by | Notes |
|---|---|---|
| `check_availability` | `computeOpenSlots` | returns `slot_id` handles, per-day spread |
| `hold_slot` | guarded PENDING appt w/ `holdExpiresAt` (10 min; 60 for gap-fill) | idempotent re-hold |
| `book_appointment` | flip own hold → BOOKED under the shared guard | re-verifies at write time |
| `reschedule` | guarded move, same-service, paid-price-change → hand off | ownership by conversation's client |
| `cancel` | `cancelAppointment` (policy fee applies; feeds gap-fill) | |
| `get_client_history` | Client cadence + visits + punches + upcoming appts | identity is DB-resolved, never model text |
| `escalate_to_human` | barber push + SMS; thread goes silent | |

**Double-booking cannot happen silently:** every write goes through
`engines/bookingWrite.ts` (per-staff advisory lock + buffer-padded overlap
re-check + the partial unique backstop) — the same single guard used by the
public booking page, dashboard, and recurring series.

## Guardrails

- **STOP always wins**: opt-out closes every live thread instantly; sends
  re-check `optedOut` at send time.
- Inbound replies (client texted first) bypass quiet hours and the daily cap
  but never opt-out. Proactive gap-fill honors the FULL rails: consent
  (`smsConsentAt`), quiet hours (skip, not queue), `dailySendCap` (kind
  `receptionist` counts; `receptionist_reply` doesn't), 72h per-client offer
  suppression.
- Every turn is audited: `ReceptionistConversation` + `ReceptionistMessage`
  rows (incl. every tool call's input/result) and a `Nudge` ledger row per SMS.
- Anything abnormal (API error, refusal, runaway loop, upset client) →
  escalate: barber gets push+SMS with the reason, thread flips to `escalated`,
  the AI goes silent on it.
- `DRY_RUN=true` suppresses receptionist SMS like every other send path.

## Gating (all must hold — evaluated in `receptionist/config.ts`)

1. `ANTHROPIC_API_KEY` set (env; feature fully dark without it)
2. `Shop.receptionistEnabled` (settings toggle)
3. `Shop.receptionistTermsAcceptedAt` — the liability click-through. The
   settings PATCH **rejects** enabling without `acceptReceptionistTerms: true`.
4. `Shop.bookingMode === "native"` (Acuity/Square are read-only syncs — no write API)
5. Active base billing (`hasActiveAccess`)
6. Add-on entitlement: `receptionistCompAccess` (comped pilot) OR an active
   $40/mo add-on subscription (`POST /api/billing/receptionist/checkout`,
   dark until `STRIPE_RECEPTIONIST_PRICE_ID` is set; webhook syncs
   `receptionistSubscriptionStatus` via the `addon: "receptionist"` metadata)

## Simulate locally (before anything touches a real client)

```powershell
# .env needs ANTHROPIC_API_KEY; DB must be dev/local (prod is hard-blocked)
pnpm --filter @chairback/api exec tsx scripts/receptionist-sim.ts --shop <slug> --phone +1555XXXXXXX
# non-interactive: --script turns.json  (a JSON array of inbound texts)
```

The simulator swaps in a capture message provider (nothing is ever sent), runs
the REAL prompt file + REAL Anthropic model + REAL slot engine against your
dev DB, and prints every tool call, its result, and the reply per turn. It
also tells you exactly which gate fails if the shop isn't eligible.

Deterministic tests (no API key, scripted model): `apps/api/src/receptionist/*.test.ts`,
`apps/api/src/engines/bookingWrite.test.ts` — run with
`$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/chairback_test'; pnpm --filter @chairback/api test`.

## Per-shop go-live checklist

1. `bookingMode = native`, staff + services + weekly availability filled in
2. Settings: accept the AI liability acknowledgment + flip the toggle
   (`PATCH /api/shops/me` with `receptionistEnabled: true, acceptReceptionistTerms: true`;
   optional `receptionistTone`)
3. Entitlement: comp the pilot (`receptionistCompAccess`) or subscribe to the add-on
4. Clients must exist with the phone numbers that will text in (shared-number
   v1 serves KNOWN clients only; unknown numbers keep STOP/START-only behavior)

## Platform go-live checklist (Eric)

- `ANTHROPIC_API_KEY` in Railway (+ local `.env`); optional `RECEPTIONIST_MODEL`
  (default `claude-sonnet-5`)
- **Twilio A2P campaign must be APPROVED before any prod shop is enabled** —
  the receptionist sends real SMS on the shared number
- Create the $40/mo price in Stripe → set `STRIPE_RECEPTIONIST_PRICE_ID`
- Verify `ai/receptionist-prompt.md` ships in the deploy (repo root, read at runtime)
- Prod migration via `railway` preDeploy (`migrate deploy`) — includes the
  receptionist tables + job-lease seeds

## Known v1 limits / deferred

- Shared platform number: unknown texters can't be routed to a shop (per-shop
  numbers plan removes this later)
- Gap-fill triggers on cancellations/no-shows only (natural-hole scanning is a
  fast-follow), one candidate per freed slot (no cascade on decline)
- No dashboard transcript UI yet (data model + `forShop` delegates are ready)
- Legal copy (terms §6, privacy subprocessor) is drafted language, not legal
  advice — worth a lawyer pass before charging for the tier
