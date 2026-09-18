# Post-service checkout

The barber finishes the cut, opens the appointment, presses **Start checkout**,
and collects what is owed — on the card the customer already saved, or by
recording cash. Tap to Pay on iPhone is the next release and is dark until then.

This is a different thing from every other money path in ChairBack, and the
difference is the whole design:

| | when | why |
|---|---|---|
| deposit / pay-ahead | before the service | to hold a chair |
| no-show / late-cancel fee | instead of the service | because it did not happen |
| **service checkout** | after the service | because it **did** |

Read `docs/financial-integrity.md` first if you are touching any of it.

---

## The rules that are not negotiable

**1. The customer's agreement to a fee is not agreement to a service charge.**
The card-on-file consent collected at booking covers no-shows and late
cancellations. Charging that same card for the haircut needs its own
authorisation, and `packages/config/src/checkoutConsent.ts` owns the wording,
the version, and the eligibility rule. The booking page renders it; the API
refuses a charge without it. They read the same file so they cannot drift.

- Recorded per card: version, timestamp, scope (`single` | `series`).
- Scope `single` covers **that appointment only**. `series` is accepted in its
  own sentence and is the only thing that reaches a standing appointment's
  other occurrences.
- Every card saved before this shipped has `NULL` and stays `NULL`. **There is
  no backfill and no barber-side path to supply it.**
- Changing the wording means minting a new version. The old entry stays in that
  file forever, so a charge taken last month can still be explained.

**2. The client never names the price.** The screen shows a figure and asks the
barber to confirm it, but what may be charged is computed in
`apps/api/src/engines/serviceCheckout.ts` from the ticket and the payments
already recorded. A request may confirm at or below that; above it is refused
outright (`amount_not_authorized`). Tips and raised totals are out of this
release — a barber pressing a button is not the customer agreeing to a bigger
bill.

**3. A fee already charged does not reduce what is owed for the service.**
`purpose: "fee"` rows are excluded from the balance. Counting them would hand
someone a free cut because they were once charged for missing one.

**4. The webhook settles, not the browser.** The HTTP response tells the barber
what Stripe said at that instant; `applyPaymentEvent` →
`settleAttemptFromIntent` is what moves a `CheckoutAttempt` to its final state.
They can arrive in either order; whichever is second finds the work done.
Terminal states refuse to reopen.

**5. One unresolved collection per appointment, across all methods.** A partial
unique index, not a read:

```sql
CREATE UNIQUE INDEX "CheckoutAttempt_appointmentId_live_key"
  ON "CheckoutAttempt"("appointmentId")
  WHERE "state" IN ('pending','processing','requires_action','ambiguous');
```

A card charge that timed out **blocks Tap to Pay and blocks Cash**. "I don't
know if that went through" is exactly the state in which collecting again
charges the customer twice.

**6. `ambiguous` is not dismissible.** Only the reconciler, which reads Stripe's
own answer, may resolve one. `requires_action` **is** cancellable, because it is
knowably unpaid — and the cancel cancels the intent at Stripe first, refusing to
free the appointment if that fails.

---

## The ledger

`Payment.appointmentId` used to be `UNIQUE`, so a booking that had taken a
deposit could not also record the balance. It is now indexed, with a
discriminator and a narrower unique:

- `Payment.purpose` — `booking` | `fee` | `service_checkout` (CHECK-pinned).
- `Payment_appointmentId_booking_key` — partial unique on `purpose='booking'`,
  which preserves the invariant that actually mattered (a deposit cannot be
  taken twice).
- Existing `mode='card_on_file'` rows were backfilled to `fee`; everything else
  is `booking`. No Stripe id was rewritten and no amount moved.

`Appointment.payments` is a list. Each read was given the filter that matches
what it means — refunds, hold sweeps, reschedule price guards and the
receptionist's fee quote want the **booking** payment; revenue and the agenda's
collected figure **sum every row**.

`CheckoutAttempt` is the attempt ledger: appointment, shop, client, acting user,
amount, currency, reason, method, payment-method reference and display-safe card,
the consent version and timestamp copied at charge time, the Stripe intent id,
the idempotency key, state, failure reason, and created/updated/settled stamps.

**The Stripe idempotency key is attempt-scoped** (`svc-checkout:<attemptId>`).
The fee helper keys on the **card** (`cof-charge:<cardRowId>`) — sharing that
key would make a service charge silently replay the fee's result.

**The concurrency guard against a fee charge is the CardOnFile CAS**
(`saved → charging`), deliberately identical to the fee path's. Whichever claims
the row first wins; the other is told `already`.

---

## Connect shape

Unchanged from every other charge here: a **destination charge on the platform
account**, with `on_behalf_of` and `transfer_data.destination` naming the
barber's connected account, and `application_fee_amount` from
`Shop.platformFeeBps`. No `Stripe-Account` header. Stripe secret keys exist only
in the API — never in the web or native client (`financialInvariants.test.ts`
enforces this by source scan).

---

## API

All under `/api/checkout`, behind `requireUser + requireShop + requireManager +
requireActiveAccess`, shop-scoped through `forShop()` with an explicit `shopId`.
Another shop's appointment id is **404, not 403** — an authorization error would
confirm the row exists.

| | |
|---|---|
| `GET /appointments/:id` | what the screen may offer, and **why not** when it may not |
| `POST /appointments/:id/charge-card` | `{ amountCents, requestId }` |
| `POST /appointments/:id/cash` | `{ amountCents, method, requestId, confirmed: true }` |
| `POST /appointments/:id/cancel-attempt` | `{ attemptId }` — `requires_action` only |

Nothing customer-sensitive is logged: ids, amounts and outcomes only.

---

## Rollout

The feature is **inert for every existing shop** on deploy, because eligibility
requires a consent that no existing card has. That is the safety property to
lean on.

1. **Migrate.** Railway runs `migrate deploy` as `preDeployCommand`, before the
   new container takes traffic, so a failed migration blocks the deploy rather
   than half-applying. The migration is additive; the only destructive step is
   dropping `Payment_appointmentId_key`, which is replaced by a partial unique
   in the same transaction.
2. **Deploy the API first, then the web.** The web calls `/api/checkout`; the
   API tolerates a web that never calls it.
3. **Confirm the webhook.** `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.processing` and
   `payment_intent.canceled` must be subscribed on the live Connect endpoint. A
   charge still works without them — the HTTP response reports it — but nothing
   would ever *settle*, and every appointment would stay locked behind a live
   attempt. **Check this before letting a real shop use it.**
4. **Watch the first live charges.** `service checkout: saved card attempt` in
   the API log carries shopId, appointmentId, attemptId, actorUserId, amount and
   outcome.
5. **Reconciler.** `PAYMENTS_RECONCILE_ENABLED=true` is what resolves an
   `ambiguous` attempt without a human. Until it is on, an ambiguous attempt
   stays locked and someone has to look at Stripe.

### Rollback

- **Code:** revert the three commits, or roll the API back. The migration is
  additive, so old code runs against the new schema with one exception: old code
  does `payment.findUnique({ where: { appointmentId } })`, which is no longer a
  unique — that is a compile-time shape, so a rolled-back **build** is
  self-consistent. Data written by the new code (extra `Payment` rows with
  `purpose='service_checkout'`) is invisible to the old reads.
- **Feature only, no deploy:** stop offering the consent checkbox (the web half),
  and no new card becomes eligible. Cards already consented stay chargeable.
- **Hard stop:** `UPDATE "CardOnFile" SET "serviceChargeConsentVersion" = NULL,
  "serviceChargeConsentAt" = NULL, "serviceChargeConsentScope" = NULL;` makes
  every saved card fee-only again and the saved-card option disappears
  everywhere. Cash checkout keeps working.
- **Do not** drop the `purpose` column without first re-checking that no
  appointment has two payment rows — the old unique index cannot be recreated
  while one does.

---

## Tap to Pay on iPhone — what is owed before it can ship

The server half already exists (`apps/api/src/billing/terminal.ts`: connection
tokens, a per-shop Terminal Location cached on `Shop.stripeTerminalLocationId`,
card-present intents). What is missing is the native SDK half and the account
configuration below. **None of it can be done in code.**

| | who | what |
|---|---|---|
| Apple entitlement | owner | `com.apple.developer.proximity-reader.payment.acceptance` — requested through the Apple Developer account, approved per bundle id (`com.getchairback.rewards`) |
| Provisioning | owner | a profile regenerated **after** the entitlement is granted; EAS credentials refreshed |
| Stripe Terminal | owner | Tap to Pay enabled on the **platform** account, and the connected account must accept Stripe's Tap to Pay terms |
| Terminal Locations | automatic | created lazily per shop on first connection-token request |
| Device | owner | iPhone XS or later, iOS 16.4+. A simulator cannot take a real payment |
| Build | owner | an EAS dev/production build with the entitlement, then TestFlight |

Apple takes nothing from these charges: the entitlement is permission to use the
NFC hardware, and a haircut is a real-world service expressly excluded from
in-app purchase.

**The release check that has not been met:** Tap to Pay is not "working" until a
real low-dollar payment has gone through on a physical supported iPhone and the
webhook, the ChairBack ledger and the connected Stripe account all agree. The
screen advertises Tap to Pay as actionable only where the native capability and
the account are ready, so until then it reads "Not set up on this device yet".

---

## Out of scope, deliberately

Physical readers · split tender · partial payments · gift cards · automatic
gratuity · tip selection · charging an arbitrary amount against a customer ·
writing payment state back to Acuity. An Acuity-imported appointment **can** be
checked out when it has an internal ChairBack appointment record; ChairBack
remains the payment source of truth and does not tell Acuity about it.
