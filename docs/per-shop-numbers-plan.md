# Per-shop SMS numbers — implementation plan

**Status: DESIGN ONLY. Do not build yet.** Banked spec for the feature that lets
each shop send from its own local phone number instead of the one shared
platform number.

## When to build this (the trigger)

Not now. Today (3 real shops) the shared `TWILIO_FROM_NUMBER` is fine, and the
message *content* is already personalized per shop (`{shop}` placeholder in
`apps/api/src/messaging/templates.ts`). Build this when the shared number's seams
appear — practically, at **~10-20 active shops**, whichever of these comes first:

- Deliverability dips (rising carrier filtering / spam-block rates on the shared
  number), or
- Evening send windows contend (many shops' quiet-hours releases pile up behind
  one number's throughput), or
- A shop's promo draws spam complaints and you don't want it degrading everyone.

Until then this is premature — it optimizes traffic you don't have.

## Why this design (and not the alternatives)

Decision (see memory `chairback-session-2026-06-22` discussion): at ~100 shops
the correct model is **one A2P Brand (the LLC) → one Campaign → N local 10DLC
numbers, one per shop, all under that single campaign.**

- NOT a shared number at scale: one shop's spam complaints sink everyone's
  deliverability; throughput bottlenecks; "many businesses, one number" is the
  snowshoeing pattern carriers flag.
- NOT toll-free: funneling many businesses through one toll-free identity is
  worse than the shared-number problem and loses the local-area-code feel.
- NOT barbers' own personal phones: no legitimate API; against carrier terms;
  bans their personal line; A2P exists specifically to stop this.
- NOT a Brand per shop: massive registration overhead + cost. The point of YOUR
  brand + one campaign is that shops inherit your compliant umbrella.

Cost at 100 shops: ~$1/number/mo (~$100/mo) + a few $/mo for the one
brand+campaign + ~$0.0079/SMS. Per-shop ~$1/mo + usage — pass-through in pricing.

## Current architecture (the seams this plugs into)

The code already isolates the right places — this is an extension, not a rewrite:

- **Send wrapper:** `apps/api/src/messaging/twilio.ts` `TwilioMessageProvider.send()`
  is the ONE place `from: env.TWILIO_FROM_NUMBER` is set. Comment there already
  calls the per-shop number "a future seam."
- **Provider interface:** `apps/api/src/messaging/provider.ts` `SendMessageInput`
  is currently `{ to, body }`. It needs a `from` (or `shopId`) added.
- **Factory / kill switch:** `getMessageProvider()` returns Noop when `DRY_RUN`.
  Keep this exactly — per-shop numbers must still be fully suppressed by DRY_RUN.
- **Send callers** (every path that ultimately calls `provider.send`): the nudge
  sweep (`apps/api/src/engines/nudge.ts`), promo blast
  (`apps/api/src/routes/promotions.ts`), loyalty earn/redeem
  (`apps/api/src/services/loyaltyNotify.ts`), manual + bulk nudge
  (`apps/api/src/routes/dashboard.ts`). Each already has the `shop` in scope.
- **Inbound:** `apps/api/src/routes/webhooks.twilio.ts` handles STOP/START. Today
  it opts out EVERY client matching the sender phone (shared-number safe choice).
  Its own comment flags this as the future seam.
- **Shop model:** `packages/db/prisma/schema.prisma` `model Shop` — add the
  per-shop number columns here.

## Build plan

### 1. Schema (migration)

Add to `model Shop`:

```prisma
  // Per-shop SMS sending number (E.164), provisioned under the platform A2P
  // campaign. NULL = shop falls back to the shared TWILIO_FROM_NUMBER.
  smsNumber        String?  @unique
  smsNumberSid     String?  // Twilio IncomingPhoneNumber SID (for release/lookup)
  smsNumberStatus  String   @default("none") // none | provisioning | active | failed | released
```

`@unique` on `smsNumber` is what makes inbound routing reliable (one number → one
shop). Keep nullable so existing shops + any un-provisioned shop transparently use
the shared number — zero behavior change until a number is assigned.

### 2. Send routing (make the from-number per-shop)

- Extend `SendMessageInput` with `from?: string` (E.164). When present,
  `TwilioMessageProvider.send` uses it; when absent, falls back to
  `env.TWILIO_FROM_NUMBER`. Noop provider ignores it (still suppressed).
- At each send caller, resolve the from-number from the shop:
  `const from = shop.smsNumberStatus === "active" ? shop.smsNumber : undefined`
  and pass it through. The shop is already loaded in every one of these paths.
- ONE chokepoint helper (e.g. `resolveShopFromNumber(shop)`) so the
  active-status + fallback logic lives in a single place, not copied 5 times.

### 3. Inbound routing (STOP/START to the right shop)

Twilio posts the destination number as `To` on the inbound webhook. Change
`webhooks.twilio.ts`:

- Read `To` (E.164). Look up the shop by `smsNumber = To`.
- Scope the STOP/START `updateMany` to `{ phone: from, shopId: shop.id }` — opt
  the client out of THAT shop only, not platform-wide. (Today's platform-wide
  opt-out is the correct shared-number behavior; per-number it must narrow.)
- If `To` matches no shop number (i.e. the shared number is still in use for
  un-provisioned shops), keep TODAY's behavior: opt out all matches. Both worlds
  coexist during rollout.
- Signature validation already uses the request URL — unchanged.

### 4. Provisioning (buy + attach a number per shop)

- Twilio API: search available local numbers by area code
  (`availablePhoneNumbers`), buy one (`incomingPhoneNumbers.create`), set its
  inbound SMS webhook to `${API_BASE_URL}/webhooks/twilio/inbound`, and attach it
  to the A2P **Messaging Service / campaign** so it sends under the registered
  brand. Store `smsNumber` + `smsNumberSid`, set status `active`.
- Area code: derive from the shop's `bookingUrl` region or ask at onboarding;
  fall back to a default metro. Not all area codes have stock — handle "none
  available, pick nearby."
- Trigger: an operator action first (admin portal button — lowest risk), then
  optionally automatic at shop onboarding once proven.
- Status lifecycle: `none → provisioning → active` (or `failed`). A `released`
  state + a release path (`incomingPhoneNumbers(sid).remove()`) for churned shops
  so you stop paying number rent.

### 5. Reputation / observability

- The `Nudge` ledger already stores the provider sid + status. Add the
  from-number (or shopId is already there) so per-number delivery/failure is
  queryable.
- A small operator view: per-number sent / delivered / failed / opt-out counts,
  so a degrading number is visible before it tanks a shop.

## Compliance notes (don't skip)

- Every provisioned number MUST be registered under the platform A2P campaign
  before it sends, or its traffic gets filtered just like an unregistered number.
  Provisioning is not "buy a number" — it's "buy + attach to the campaign."
- The STOP/START narrowing (per-shop opt-out) is a real TCPA behavior change:
  verify a client who stops one shop still can't be texted by that shop, and
  confirm the platform-wide STOP still works for the shared-number fallback.
- DRY_RUN must remain a hard global kill switch through all of this. No per-shop
  number path may send while DRY_RUN=true.

## Testing

- Send routing: shop with `smsNumberStatus=active` sends from `smsNumber`; shop
  with status `none` sends from the shared number; Noop suppresses both.
- Inbound: STOP to a shop number opts out only that shop's matching clients; STOP
  to the shared number (no match) keeps platform-wide behavior.
- Provisioning: status transitions; failed-provision leaves the shop on the
  shared number (never broken).
- All existing SMS tests must stay green — the shared-number path is unchanged
  when `smsNumber` is null.

## Rollout sequence

1. Ship schema + send routing + inbound routing with NO numbers provisioned →
   100% of shops still on the shared number, zero behavior change (safe deploy).
2. Provision ONE pilot shop via the operator action; verify send + STOP end to
   end against the real number.
3. Backfill the rest; flip onboarding to auto-provision.
