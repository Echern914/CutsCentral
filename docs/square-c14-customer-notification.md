# C14 — does Square tell the *customer* about a mirrored booking?

## The answer: it is a per-seller dashboard toggle, and the API cannot read it

**Square Dashboard → Appointments → Settings → Communications → "Confirmations
and Reminders".**

Three properties of that setting decide the design:

1. **It is account-level.** Not per-service, not per-booking, not per-location.
   One switch covers every appointment the seller has.
2. **It does not distinguish who created the booking.** Square's own help text
   makes no seller-created-versus-customer-booked distinction; the setting
   "appears to apply uniformly across all appointment types once enabled". A
   booking ChairBack writes is, to Square, just an appointment.
3. **🔴 It is not exposed in the API.** `RetrieveBusinessBookingProfile` on a
   real sandbox seller returned exactly:

   ```
   seller_id · created_at · booking_enabled · customer_timezone_choice
   booking_policy · allow_user_cancel · business_appointment_settings
   support_seller_level_writes
   ```

   No notification field of any kind, and none in `location_booking_profiles`
   either. Square's API reference documents the same set.

### What that forces

We cannot read this state, so we cannot verify it, so **we cannot infer it**.
That makes it an onboarding requirement rather than a capability check:

> A shop must not be able to arm ENFORCE until a human has confirmed what their
> Communications setting is. An unread toggle is not a safe default in either
> direction — assuming it is off risks texting strangers, assuming it is on
> risks refusing to arm a shop that is perfectly fine.

The honest implementation is an explicit attestation in the setup UI, stored
with a timestamp and re-asked after an OAuth reconnect (the seller may have
changed it). **This is not built yet** — it belongs with S3's readiness work,
and it is a gate on enabling the mode, not on merging the code.

## Why this may be mostly theoretical for ChairBack specifically

`ensureCustomerFor` files every mirrored booking under a **name-only** Square
customer:

```ts
// Name only. The appointment also carries a phone and an email, and neither
// is sent: this mirror exists to hold a slot, not to replicate a shop's
// contact book into a third party.
```

No email, no phone — so on the mirror's own customer records Square has **no
channel to send on**. `ensureCustomer` resolves by ChairBack's own
`reference_id` (`chairback:<shopId>:<clientId>`), which cannot collide with a
customer record the seller created themselves.

That is a real structural mitigation, and it was written for an unrelated reason
(not exporting a shop's contact book). It is not proof, for two reasons:

- a seller can add contact details to that customer record by hand in Square,
  at which point the channel exists;
- nobody has ever watched what Square actually does here.

Which is what the test below is for.

---

## The production test

One booking, cancelled immediately. Do **arm B** — the name-only case is already
determined by having no channel, so it would tell you nothing you don't know,
while arm B tells you what happens the day a customer record does have contact
details.

### Before you book — record the state we can't read

1. Square Dashboard → **Appointments → Settings → Communications**.
2. **Screenshot the whole "Confirmations and Reminders" section.** Note for
   each: confirmation **email** on/off, confirmation **text** on/off, reminder
   email/text on/off and their timings.
3. If confirmations are **off**, turn the email one **on** for the test —
   otherwise the test cannot produce a signal and a silent result would be
   meaningless. Put it back afterwards.

That screenshot is the artifact. It is the exact state a shop would have to
attest to during onboarding.

### The booking

Create it the way the mirror does — a **seller-level API booking** with a
customer record carrying your real email and phone.

```bash
# Production. Personal access token from the Square Developer Console,
# PRODUCTION credentials, your own seller.
export SQ=<production access token>
export H="Authorization: Bearer $SQ"
export V="Square-Version: 2026-05-20"

# 1. A customer with YOUR contact details (this is the difference from the mirror).
curl -s -X POST https://connect.squareup.com/v2/customers \
  -H "$H" -H "$V" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"c14-cust-1","given_name":"C14","family_name":"Probe",
       "email_address":"YOUR@EMAIL","phone_number":"+1YOURNUMBER"}'

# 2. The ids the booking needs.
curl -s -H "$H" -H "$V" https://connect.squareup.com/v2/locations
curl -s -H "$H" -H "$V" \
  'https://connect.squareup.com/v2/bookings/team-member-booking-profiles?bookable_only=true'
curl -s -H "$H" -H "$V" 'https://connect.squareup.com/v2/catalog/list?types=ITEM'
#    → pick an APPOINTMENTS_SERVICE item's variation id AND its version

# 3. The booking. Put it somewhere obviously fake and far out.
curl -s -X POST https://connect.squareup.com/v2/bookings \
  -H "$H" -H "$V" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"c14-booking-1","booking":{
        "location_id":"L...","customer_id":"<from step 1>",
        "start_at":"2026-12-15T20:00:00Z",
        "appointment_segments":[{"team_member_id":"TM...",
          "service_variation_id":"...","service_variation_version":<version>,
          "duration_minutes":30}],
        "seller_note":"ChairBack C14 notification probe - ignore"}}'
```

If you would rather not use a production token: creating the appointment from
the **Appointments calendar** in the dashboard is a weaker proxy. It is still a
seller-created booking, but its `source` is the dashboard rather than `API`, so
a null result would not fully clear the API path.

### What to watch for

**In the first two minutes**, on the email and phone you used:

- Does anything arrive at all? *(This is the headline answer.)*
- If it does — what does it say? Does it name the service, the barber, the
  price?
- 🔴 **Does it contain a cancel or reschedule link?** This matters more than the
  message itself. If Square hands the customer a self-service cancel link for a
  ChairBack-owned mirror booking, a customer can free a chair ChairBack believes
  is protected, and the only thing that would tell us is the `booking.updated`
  webhook. Capture the link's destination if there is one.
- Does the sender identity make sense for the shop, or does it look like a
  message from a business the customer never contacted?

**On cancellation** (do this immediately after):

```bash
curl -s -H "$H" -H "$V" https://connect.squareup.com/v2/bookings/<bookingId>
curl -s -X POST https://connect.squareup.com/v2/bookings/<bookingId>/cancel \
  -H "$H" -H "$V" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"c14-cancel-1","booking_version":<version from above>}'
```

- Does a **cancellation** notice go out too? A mirror releasing a slot would
  otherwise send a stranger an "your appointment is cancelled" for something
  they never booked — arguably worse than the confirmation.

### Afterwards

1. **Appointments → the booking → its history/activity** — Square often logs
   what it sent.
2. **Customers → the C14 Probe record** — check for a message/communication
   history on the profile.
3. **Delete the probe customer** and confirm the booking shows cancelled.
4. **Put the Communications toggles back** exactly as your screenshot showed.

### What each outcome means

| Result | Consequence |
|---|---|
| Nothing sent | Seller-level API bookings do not notify. The attestation becomes advisory rather than blocking. |
| Confirmation sent | 🔴 The mirror must never file a booking under a customer record with contact details, and the name-only rule in `ensureCustomerFor` becomes a **hard invariant with a test**, not a comment. |
| Confirmation **with a cancel link** | 🔴 As above, plus the mirror cannot treat `ACCEPTED` as durable protection — a customer can revoke it. The `booking.updated` handler is then the only thing standing between that and a double-booked chair. |
| Cancellation notice sent | Releasing a mirror is customer-visible. Release timing stops being purely internal. |
