# Rollout and rollback: shared-card standing appointments

A card-on-file **series** keeps ONE Stripe payment method for many
appointments. That is what makes the feature correct for the customer, who
agreed once, and it is also the one thing that makes rollback unlike every
other change in this repo.

Read this before deploying, and before reverting anything.

## The hazard, stated plainly

The API that shipped before this feature releases a card like this:

```ts
if (row.stripePaymentMethodId) {
  await stripeClient().paymentMethods.detach(row.stripePaymentMethodId);
}
```

No notion of siblings. Run that against a series **anchor** whose later visits
are still live and the whole series loses its card, while the customer still
sees one on file and the shop has nothing to charge. Nobody is charged in
error; the loss is coverage, silently.

**Deployment order cannot prevent this.** During a rolling deploy both versions
serve at once, so one old instance handling one completion is enough.

Reproduced as an executable test, so this is not a paper risk:
`apps/api/src/billing/cardOnFileSeries.test.ts` →
*"THE ROLLBACK HAZARD: old-code release strips a live sibling's card"*. It
performs the old detach verbatim and proves a sibling can no longer be charged,
then shows the current release path leaves that sibling chargeable.

## What makes it safe: an activation gate, not an ordering

`SERIES_CARD_ON_FILE_ENABLED` (default **false**, `packages/config/src/env.ts`).

While it is false, a card-on-file shop is **not offered a standing appointment
at all** — the same refusal that shipped as the interim fix — so **no
shared-card series can be created**. The code deploys everywhere dark.

Pinned by `apps/api/src/routes/bookingRecurring.public.test.ts` →
*"refuses a card-on-file series while the gate is off, and offers it when on"*,
which checks both the page and the write, because a page offering what the
write refuses is its own outage.

## Rollout

1. **Merge and deploy with the flag unset or `false`.** Nothing changes for
   anyone. Card-on-file shops keep seeing no recurring option.
2. **Verify every instance runs the new build.** Not "the deploy finished" —
   every instance, and every worker process that can charge or release a card.
   Check `/healthz` reports the expected commit, and confirm the scheduler /
   worker service is on the same revision. Railway rolls instances, so a
   deploy that reports success can still have an old instance draining.
3. **Only then set `SERIES_CARD_ON_FILE_ENABLED=true`.** From this moment
   shared-card series can exist.

Step 2 is the whole point. Do not compress it.

## Rollback

**Before any shared-card series exists** (the flag has never been on):
unrestricted. Revert the API and web deploys. The migration is additive, the
column is nullable and unread by the previous code, and no row the new code
writes has been created. No down-migration.

**Once any shared-card series exists**, the rules change:

- **Turning the flag off does NOT undo anything.** It stops *new* shared-card
  series. Existing ones still need code that resolves a sibling's method
  through the anchor and refuses to detach while siblings are live. Turn it off
  first in an incident — it is the right first move — but understand it is
  containment, not a rollback.

- **The rollback floor is the commit that merged PR #419.** Any revision at or
  after it resolves a sibling's payment method through the series anchor and
  releases only when the last occurrence is done. Reverting *below* that floor
  is **not safe** and must not be described as safe: the older release path
  will detach the anchor's method and leave siblings without coverage, exactly
  as the test above demonstrates.

- **If you must go below the floor**, accept the consequence deliberately and
  narrow it: set the flag false, let the currently-booked series run out or
  cancel them through the normal customer path, and confirm no `CardOnFile` row
  has a `seriesId` with live siblings before reverting. There is no automated
  check for this today — query it.

### Why the copies are still mostly harmless to old code

Occurrence rows deliberately carry **no** `stripePaymentMethodId`; only the
anchor holds it. Old code finds no method on a copy, so it neither detaches nor
charges one — a copy simply looks to it like a card that was never completed.
That is why the exposure after a rollback is limited to the **anchor's** method
rather than being triggerable from any of the twelve.

It is a reduction in blast radius, not an elimination. The floor above still
applies.

## Account context: why a code guard, not endpoint configuration

Every card-on-file SetupIntent is created in **platform** context —
`billing/cardOnFile.ts` passes no `stripeAccount` and names the barber's
account with `on_behalf_of` instead. A genuine `setup_intent.succeeded` for one
of ours therefore arrives with **no `event.account`**.

**Configuration does not exclude the connected-account context.** Both
`STRIPE_CONNECT_WEBHOOK_SECRET` and `STRIPE_PLATFORM_WEBHOOK_SECRET` are set in
production (verified 2026-09-13), and `verifyConnectWebhook` accepts either. So
the Connected-accounts endpoint **is** a live destination: an event describing
an intent created on a connected account reaches `applyPaymentEvent` correctly
signed and same-mode.

Signature verification cannot distinguish it. It proves Stripe sent the event,
not that the object belongs to the account we expect. A connected account
controls its own intents' metadata, so a `cardOnFileId` copied into a foreign
intent would otherwise flip one of our pending rows to `saved` and confirm a
standing appointment whose card never existed on the platform.

`applyPaymentEvent` therefore refuses `setup_intent.succeeded` outright when
`event.account` is set, returning handled so Stripe stops redelivering.

Evidence:

- `cardOnFileSeries.test.ts` → *"WEBHOOK: a correctly signed event in a
  CONNECTED-account context confirms nothing"*. It feeds the same intent object
  twice, once with an account and once without, so only the context differs.
  Removing the guard fails it with `expected false to be true`.
- `cardOnFileSeries.test.ts` → *"BROWSER: verification retrieves on the PLATFORM
  and keeps the stored associations"*. No `{stripeAccount}` option is passed on
  retrieve, the intent id comes from our own row rather than the request, and
  asking under the wrong shop returns `unknown` rather than verifying another
  shop's card.
- `routes/webhooks.integrity.test.ts` covers the separate, earlier boundary:
  invalid signature and live-mode mismatch.

## Related

- Audit of the original defect and the one affected appointment:
  `docs/audit/2026-09-13-card-on-file-series.md`
- The charge's destination account is read from the shop row, never from a
  payload — `cardOnFileSeries.test.ts` → *"the charge is aimed by OUR shop row"*.
