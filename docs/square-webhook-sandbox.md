# The Square webhook seam, measured in Sandbox

Everything below was observed against a live Square Sandbox seller
(`MLY5ZM1D2VHS0`) on **2026-08-25**. Nothing here is copied from Square's
documentation. Where a thing could not be verified in Sandbox it says so.

The seam matters because ChairBack now writes bookings *out* to Square. A
booking we create fires a webhook straight back at us, and if that round trip is
not closed, the mirror imports its own booking as a second appointment — on the
chair it was protecting.

---

## Reproducing this cold

No account is needed for the tunnel and nothing is installed system-wide.

### 1. A public URL

```bash
curl -sL -o cloudflared.exe \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
./cloudflared.exe tunnel --url http://localhost:8788 --no-autoupdate
```

It prints a `https://<random-words>.trycloudflare.com` hostname. Quick tunnels
need no Cloudflare login. **The hostname changes every restart**, and the
signature depends on it (see §3), so a restart means re-registering the
subscription.

### 2. Something listening on :8788

Either the API itself, or `scratchpad/capture-server.mjs` from this session,
which writes one JSON file per delivery and verifies the HMAC as it goes.

> ⚠️ On Windows, do **not** derive the output directory from `import.meta.url`
> when the path contains an 8.3 short name. `ERICCH~1` percent-encodes to
> `ERICCH%7E1` and `mkdir` fails with `EPERM` on a path that does not exist.
> Use `fileURLToPath()`.

### 3. Subscribe

```
POST https://connect.squareupsandbox.com/v2/webhooks/subscriptions
{
  "idempotency_key": "...",
  "subscription": {
    "name": "chairback-contract-<ts>",
    "event_types": ["booking.created", "booking.updated"],
    "notification_url": "https://<tunnel>.trycloudflare.com/webhooks/square",
    "api_version": "2026-05-20",
    "enabled": true
  }
}
```

The response carries `signature_key` — **this is the only time you get it**.
`SQUARE_WEBHOOK_SIGNATURE_KEY` must be set to it, and `API_BASE_URL` must
produce exactly the `notification_url` above, because the signature is computed
over the URL *and* the body:

```
base64( HMAC-SHA256( signature_key, notification_url + rawBody ) )
```

`GET /v2/webhooks/subscriptions` lists what exists; delete stale ones or you
will get duplicate deliveries to dead tunnels.

### 4. Drive events

Create a booking, `PUT` it to a new time, then cancel it. Scripts used here:
`sq-drive-events.mjs` and `sq-retry-trigger.mjs`.

---

## W1 — `booking.created`

**Signature verified: VALID.** The recipe above matches `verifySquareSignature`
byte for byte, confirmed on all five deliveries in this session.

| Field | Observed | Why it matters |
|---|---|---|
| `event_id` | `148af286-6322-551f-be5d-059230b12c8c` | UUID. The inbox's idempotency key. |
| `type` | `booking.created` | |
| `merchant_id` | `MLY5ZM1D2VHS0` | Top level. How the handler routes merchant → shop. |
| `location_id` | `LQ19RJFJQV7FR` | **Also top level**, outside `data`. |
| `created_at` | `2026-08-25T17:50:31Z` | |
| `data.type` | `booking` | |
| `data.id` | `f7i4eiij0bdkm3:0` | 🔴 **`<bookingId>:<version>`, NOT the bare id.** Reading `data.id` as a booking id would look right and silently never match. The handler reads `data.object.booking.id`. |
| `data.object.booking` | the **full** booking | Not a stub — no re-fetch needed to know the shape. |

The nested booking carried `id`, `status: "ACCEPTED"`, `version: 0`, `start_at`,
`customer_id`, `location_id`, `location_type`, `created_at`, `updated_at`,
`all_day`, `transition_time_minutes`, `source: "API"`,
`creator_details: { creator_type: "TEAM_MEMBER", team_member_id }`,
a complete `appointment_segments[]`, and — decisively —

```json
"seller_note": "ChairBack mirror cb_outbox_TESTROWID123"
```

**`seller_note` survives into the payload.** That single fact is what makes the
race in §W3 closable.

### `event_id` is stable across retries — measured, not assumed

The capture server was set to answer the first delivery of each event with
`500`, and Square redelivered:

| Delivery | `event_id` | Response | Signature |
|---|---|---|---|
| 1 | `733f044f-00ef-5b3b-b62a-389378d79ec5` | forced `500` | VALID |
| 2 (retry) | `733f044f-00ef-5b3b-b62a-389378d79ec5` | `200` | VALID |

Same id. Had Square minted a fresh id per attempt, `SquareWebhookEvent.eventId`
would have deduped nothing and every retry would have re-run the full pipeline.

---

## W2 — `booking.updated`, for both reschedule *and* cancel

🔴 **There is no `booking.canceled` event.** `GET /v2/webhooks/event-types`
returns 153 types; exactly two are booking lifecycle events:

```
booking.created   booking.updated
```

The other ten `booking.*` entries are custom-attribute events. A cancellation is
a `booking.updated` whose `status` changed — which is why the handler must read
status rather than switch on event type.

| Action | `type` | `data.id` | `booking.status` | `version` |
|---|---|---|---|---|
| Create | `booking.created` | `f7i4eiij0bdkm3:0` | `ACCEPTED` | 0 |
| Reschedule 15:00→16:00 | `booking.updated` | `f7i4eiij0bdkm3:1` | `ACCEPTED` | 1 |
| Cancel | `booking.updated` | `f7i4eiij0bdkm3:2` | `CANCELLED_BY_SELLER` | 2 |

`seller_note` persisted unchanged through all three. `version` increments by one
per mutation and appears in both `data.id` and the booking object.

---

## W3 — does our own mirrored booking come back as a duplicate Visit?

**It did. This was a real defect, now fixed.**

`isSelfEcho` tests membership of `ownedSquareBookingIds`, which selects
`squareBookingId: { not: null }`. But `dispatchSquareCreate` stores that id
*after* the create returns:

```
createBooking() ───────────────────────► Square
                   (fires booking.created)  │
                                            ▼
                              processBookingEvent()   ← id not stored yet
update({ squareBookingId }) ◄── still in flight
```

Inside that window the booking is invisible to the self-echo check and
`ingestSquareBooking` runs, producing a phantom second appointment on a chair
that is already booked.

`webhookSelfEcho.test.ts` reproduces it with the payload shape captured above.
Before the fix: **2 failed, 4 passed** — the two failures being the race itself
and the follow-up event that inherits it.

### The fix: a second, narrower identifier

The seller note is written *before* Square ever sees the booking and comes back
in the payload, so it covers exactly the window the id cannot.
`claimSquareBookingByNote` treats it as a **claim, never proof**:

- the note must name an outbox row that **exists**, and
- that row must belong to the **shop this event was routed to** — otherwise a
  seller pasting another shop's note could make bookings disappear from a
  calendar they do not own;
- if the row already owns a *different* booking id, the note is refused and the
  booking imports, with a warning. That is a mapping fault, not an echo, and
  suppressing it would hide a real appointment.

On a successful claim the booking id is **adopted** (guarded on
`squareBookingId: null`, so it can never overwrite a settled id), which puts
every later `booking.updated` back on the durable id path. The note does its job
once and then stops being load-bearing.

`isSquareSellerNote` already existed and was unit-tested but **called from
nowhere in production** — the fix wired up a helper that had been shipped dead.

---

## Not verified in Sandbox

Flagged rather than assumed:

- **C14 — customer notification.** Whether Square emails or texts the *customer*
  for a seller-level API booking. Sandbox does not deliver real mail, and the
  API response does not report it. This still matters: a mirror that tells a
  stranger "your appointment is confirmed" for a hold they never made is worse
  than the double-booking. **Unanswered.**
- **Ordering under load.** Square documents that it does not guarantee delivery
  order. Only sequential single-booking traffic was driven here, so reordering
  was never actually observed — the ledger is designed for it, not proven
  against it.
- **Retry schedule and give-up point.** One retry was observed. The full backoff
  curve and the 72-hour envelope were not measured.
- **`oauth.authorization.revoked`.** The handler covers it; revoking sandbox
  authorization was not exercised.
