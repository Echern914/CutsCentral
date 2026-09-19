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

**2. The client never names the price, and v1 collects the WHOLE balance or
nothing.** What may be collected is computed in
`apps/api/src/engines/serviceCheckout.ts` from the ticket and the payments
already recorded. The confirmed figure must match it **to the cent, by every
method including cash**; anything else is `amount_not_authorized`.

Lower would be a partial payment or a silent discount, higher would be
over-collection or a tip — all four are out of scope, and each would leave
`paidAt` set on an appointment that is not actually settled. A barber who wants
a different figure edits the **price**, which is an audited change with its own
ledger row, and then collects what follows from it. There is deliberately no
amount box on the checkout screen.

**3. Checkout takes money. It does not finish the cut.**
`POST /appointments/:id/complete` (**Done**) remains the sole owner of
completion *and* of the loyalty punch. Checkout writes `paidAt`, `paidAmount`,
`paidMethod` and the ledger rows, and touches `status` never.

That separation is what makes "exactly one punch" provable rather than hoped
for: nothing on the payment path awards one at all, so a payment retry, a
webhook replay, a second collection attempt and the choice of method cannot
add a second. Completion stays idempotent on its own `booking:<id>` visit key,
and `PunchLedger.visitId` is `UNIQUE` — one earn per visit, enforced by the
database.

Both methods behave identically here: neither completes anything, and both
release a kept card once the balance is settled (a card this checkout just
charged is already `charged`, and `releaseCardOnFile` returns early for that, so
the same call is correct for both).

**Done first, then collect, is the ordinary case — not an edge one.** This is
POST-service checkout, so completion deliberately does *not* take the card away
from a cut that still owes. A card is retained past Done when all three hold:

1. the customer gave **service-charge consent**,
2. a **balance is outstanding**, and
3. the appointment ended less than `SERVICE_CHARGE_RETENTION_HOURS` (**72h**) ago.

Miss any one and completion releases it exactly as it always did — a fee-only
card is never retained. Past the window the card stops being eligible for a
service charge (`retention_expired`) and the ordinary release takes it. An
open-ended right to charge for a haircut somebody had last month is not what
they agreed to.

**A card mid-charge is not available to the fee path.** `processing`,
`requires_action` and `ambiguous` all keep the CardOnFile row `charging`, so a
no-show marked in that window cannot take a fee on a card whose service intent
is still confirmable. Only a **confirmed** cancellation (the intent cancelled at
Stripe first) or a definitive failure hands it back.

**4. A fee already charged does not reduce what is owed for the service.**
`purpose: "fee"` rows are excluded from the balance. Counting them would hand
someone a free cut because they were once charged for missing one.

**5. The webhook settles, not the browser.** The HTTP response tells the barber
what Stripe said at that instant; `applyPaymentEvent` →
`settleAttemptFromIntent` is what moves a `CheckoutAttempt` to its final state.
They can arrive in either order; whichever is second finds the work done.
Terminal states refuse to reopen.

**6. One unresolved collection per appointment, across all methods.** A partial
unique index, not a read:

```sql
CREATE UNIQUE INDEX "CheckoutAttempt_appointmentId_live_key"
  ON "CheckoutAttempt"("appointmentId")
  WHERE "state" IN ('pending','processing','requires_action','ambiguous');
```

A card charge that timed out **blocks Tap to Pay and blocks Cash**. "I don't
know if that went through" is exactly the state in which collecting again
charges the customer twice.

**7. `ambiguous` is not dismissible.** Only the reconciler, which reads Stripe's
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

The feature is **dark on deploy**: `SERVICE_CHECKOUT_ENABLED` defaults to
false, so `/api/checkout` answers 404 and the appointment sheet keeps the
original chair-checkout screen. Nothing is added and nothing is taken away.

(The consent requirement is a second, independent floor — no card saved before
this release is eligible for a service charge — but it is not by itself a kill
switch, because Cash/Other needs no consent. The flag is the switch.)

1. **Deploy with the flag OFF** and confirm nothing changed: the sheet still
   shows the original checkout, and `GET /api/checkout/...` is 404.
2. **Migrate.** Railway runs `migrate deploy` as `preDeployCommand`, before the
   new container takes traffic, so a failed migration blocks the deploy rather
   than half-applying. The migration is additive; the only destructive step is
   dropping `Payment_appointmentId_key`, which is replaced by a partial unique
   in the same transaction.
3. **Deploy the API first, then the web.** The web calls `/api/checkout`; the
   API tolerates a web that never calls it.
4. **Confirm the webhook.** `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.processing` and
   `payment_intent.canceled` must be subscribed on the live Connect endpoint. A
   charge still works without them — the HTTP response reports it — but nothing
   would ever *settle*, and every appointment would stay locked behind a live
   attempt. **Check this before letting a real shop use it.**
5. **Watch the first live charges.** `service checkout: saved card attempt` in
   the API log carries shopId, appointmentId, attemptId, actorUserId, amount and
   outcome.
6. **Reconciler.** `PAYMENTS_RECONCILE_ENABLED=true` is what resolves an
   `ambiguous` attempt without a human. Until it is on, an ambiguous attempt
   stays locked and someone has to look at Stripe.
7. **Then turn it on** — `SERVICE_CHECKOUT_ENABLED=true` — for one shop first.

### Rollback

**The undo is the flag.** `SERVICE_CHECKOUT_ENABLED=false` closes the whole
surface: every `/api/checkout` route answers 404, the appointment sheet goes
back to the original chair-checkout screen, and every record stays exactly as
it is. It needs no deploy, loses no data, and is safe at any time.

```
SERVICE_CHECKOUT_ENABLED=false   # takes effect on the next API boot
```

🔴 **There is a rollback FLOOR, and it is the first successful checkout.**

Before that point, reverting the build is safe: the migration is additive, and
nothing has written a second `Payment` row for any appointment.

After it, **reverting the build is not a safe rollback.** An old build reads
`payment.findUnique({ where: { appointmentId } })`. That is no longer a unique
index, so on an appointment carrying both a deposit and a service checkout the
old code does not fail — it reads **one of the two rows, unpredictably**, and
then refunds, reschedules or quotes a cancellation fee against whichever it
happened to get. Silent, and about money.

So past the floor: **flag off and roll forward.** If the schema itself must be
undone, do it deliberately and in this order:

1. `SERVICE_CHECKOUT_ENABLED=false`, and confirm no attempt is unresolved:
   `SELECT count(*) FROM "CheckoutAttempt"
    WHERE state IN ('pending','processing','requires_action','ambiguous');`
2. Find every appointment the old shape cannot represent:
   `SELECT "appointmentId", count(*) FROM "Payment"
    GROUP BY 1 HAVING count(*) > 1;`
3. Reconcile those by hand — there is no automatic answer, because deciding
   which row is "the" payment is exactly the judgement the old schema could not
   make.
4. Only once that query is empty can `Payment_appointmentId_key` be recreated
   and the old build run safely.

🔴 **Never null the consent columns as a rollback.**
`serviceChargeConsentVersion` / `At` / `Scope` are the customer's own record of
what they agreed to and when. Deleting them destroys the evidence for charges
that have already been taken, and leaves a charged card with nothing on file
explaining why it was chargeable. The flag achieves the same "no new service
charges" outcome and keeps the history.

- **Narrower stop, no deploy:** remove the consent checkbox from the booking
  page and no NEW card becomes eligible, while existing ones keep working.

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

### The real-iPhone test script

Run this once the entitlement is granted and the build is on the device. Do it
on a **real shop's own connected account** with a **$1.00** ticket, and do not
claim Tap to Pay works until every line is ticked.

1. **Device check.** iPhone XS or later, iOS 16.4+, signed into the device's
   own Apple ID, NFC not blocked by a case. Open ChairBack, sign in as the
   shop owner.
2. **Account check.** In Stripe, confirm the connected account has accepted the
   Tap to Pay terms and that a Terminal Location exists for the shop
   (`Shop.stripeTerminalLocationId` is non-null after the first connection
   token).
3. **Create the ticket.** Book a $1.00 appointment for a test client, in the
   past, so it is checkout-eligible.
4. **Open checkout.** Appointment → **Start checkout**. Tap to Pay must now be
   an actionable row, not the "Not set up on this device yet" line. If it is
   still inert, stop: the device or the account is not ready and nothing below
   will mean anything.
5. **Confirm, then tap.** Choose Tap to Pay, check the confirm screen says
   **$1.00**, press Charge, and hold a real card to the phone.
6. **Result screen.** It must say Paid $1.00, name the card, carry a timestamp
   and a reference, and offer the way back to the appointment.
7. **Three-way agreement — this is the actual test.**
   - **Stripe:** a `card_present` PaymentIntent, `succeeded`, $1.00, with
     `on_behalf_of` and `transfer_data.destination` set to the shop's connected
     account, and the application fee as expected.
   - **ChairBack ledger:** one `Payment` row, `purpose='service_checkout'`,
     `status='succeeded'`, `amount=100`; one `CheckoutAttempt`,
     `method='tap_to_pay'`, `state='succeeded'`, `settledAt` set.
   - **Connected account:** the $1.00 appears in that account's balance, not
     the platform's.
8. **Webhook.** Confirm the `payment_intent.succeeded` event was delivered and
   that the attempt reached `succeeded` **from the webhook** — kill the app
   immediately after the tap and re-open it; the appointment must read Paid
   without the client ever having seen the response.
9. **Refund it.** Refund the $1.00 in Stripe and confirm `refundedAmount`
   updates on the Payment row.
10. **Then, and only then**, say Tap to Pay works.

---

## Out of scope, deliberately

Physical readers · split tender · partial payments · gift cards · automatic
gratuity · tip selection · charging an arbitrary amount against a customer ·
writing payment state back to Acuity. An Acuity-imported appointment **can** be
checked out when it has an internal ChairBack appointment record; ChairBack
remains the payment source of truth and does not tell Acuity about it.
