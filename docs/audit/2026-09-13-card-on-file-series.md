# Card-on-file standing appointments — audit of 2026-09-13

A read-only audit of Drickcuttinup's bookings after the card-on-file series
defect. Recorded so the state of one specific appointment is not lost, and so
nobody later mistakes a fixed code path for a fixed booking.

## What was read, and what that does and does not prove

**Source: the production database only.** Read-only queries through the API's
own Prisma client. No writes, no Stripe API calls, no customer messages, no
charges, and no change to any shop setting.

Two limits on what follows, stated because they change how much weight it can
carry:

- **There was no Stripe-side verification.** Every statement about cards below
  describes *our rows*. A row marked `released` records that we asked Stripe to
  detach the payment method and marked our own row accordingly. It is **not**
  independent proof that the method is absent from Stripe today. Confirming
  that needs a Stripe read against the platform account, which this audit did
  not perform.
- **The date of the first card row does not establish when the setting was
  switched on.** The earliest `CardOnFile` row for this shop is 2026-09-04. That
  is the first time a card was *collected*, which is a lower bound on when
  `card_on_file` was enabled and nothing more. We keep no configuration history,
  so the enabling date is unknown.

## Findings

Shop configuration at the time of the audit:

| Setting | Value |
|---|---|
| `paymentsMode` | `card_on_file` |
| Connect charges enabled | yes |
| `chargeCardOnFileFees` | **false** |
| Cancellation window | 0 hours |
| Cancellation fee | 0 bps |

The series asked for **12** occurrences and materialised **1**. The other
eleven were skipped as already taken, which matches what the customer's own
confirmation screen showed at the time ("1 of 12 visits booked"). The earlier
claim that twelve chairs were left unprotected was wrong.

Upcoming booked appointments:

| Date | Created | Card | Consent | Classification |
|---|---|---|---|---|
| 2026-09-18 | 2026-08-26 | none | none recorded | Missing card; predates the first card row |
| 2026-09-24 | 2026-08-27 | none | none recorded | Missing card; predates the first card row |
| **2026-09-27** | 2026-09-13 | **none** | **none recorded** | **Missing card, caused by the series defect** |

Verified coverage: none of the three. Unknown status: none — every row
resolved.

Three historical `CardOnFile` rows exist for this shop, all `released` in our
records. One of them recorded a Visa ending 8392 before release.

## The record for 2026-09-27

**This appointment is preserved and unchanged.** It stays BOOKED.

**It has no booking-linked card and no recorded customer consent to keep one.**
No SetupIntent was ever completed for it, because the code path that would have
asked for one did not exist when it was booked.

**A later booking does not retroactively protect it.** When this customer next
books, the fixed code will collect a card for *that* booking. That card belongs
to the booking it was collected for. It does not attach to 2026-09-27, does not
cover it, and must never be described as though it does.

**No recovery was performed and no fee settings were changed.** Deciding
whether to pursue a card for this appointment is the shop owner's call. Note
that with `chargeCardOnFileFees` false and a zero-percent cancellation fee, a
card on file would not currently be chargeable for a no-show regardless.

## Not addressed here

The two August appointments are outside the defect's scope. They were created
before any card was ever collected for this shop, so no code change would have
given them one.
