import type { Prisma } from "@chairback/db";
import { suppressionAddressHash, type AddressSuppressions } from "../engines/broadcastAudience.js";

/**
 * MARKETING-EMAIL SUPPRESSIONS, BOUND TO THE ADDRESS THEY ARE ABOUT (#514).
 *
 * An unsubscribe or a bounce used to live only on the client record - and a
 * record's address changes. So an old bounce followed the record onto its new,
 * working address, and once an opted-out record moved to a new address (or was
 * blanked by the customer deleting their data), the address they had
 * unsubscribed became mailable again on any other record that carried it.
 * EmailAddressSuppression names the address itself - as a shop-scoped hash, so
 * no address is kept - and the broadcast audience split excludes it on every
 * record, whatever happens to the record that caused it.
 *
 * Marketing only. Appointment email reads none of this.
 */

export type EmailSuppressionKind = "unsubscribe" | "bounce" | "complaint";

/**
 * 🔴 THE ONE PLACE A SUPPRESSION IS WRITTEN - and the place a lift will go.
 *
 * Idempotent: a repeat of the same address and kind changes nothing, so the
 * first time it was seen is the time kept. ON CONFLICT DO NOTHING rather than
 * a create that throws, because a caught unique violation still aborts the
 * caller's transaction.
 *
 * Nothing lifts one yet. An unsubscribe is undone only by the person
 * re-subscribing, which does not exist today; when it does, the delete belongs
 * here, beside this insert, and nowhere else. An email change, a sync, an
 * import or a merge never touches this table.
 */
export async function recordEmailSuppression(
  tx: Prisma.TransactionClient,
  p: {
    shopId: string;
    address: string | null | undefined;
    kind: EmailSuppressionKind;
    /** Where the fact came from: "unsubscribe_link", "provider_webhook", "square_sync". */
    source: string;
  },
): Promise<void> {
  const addressHash = suppressionAddressHash(p.shopId, p.address);
  if (addressHash === null) return;
  await tx.emailAddressSuppression.createMany({
    data: [{ shopId: p.shopId, addressHash, kind: p.kind, source: p.source }],
    skipDuplicates: true,
  });
}

/**
 * A shop's suppressions, in the shape splitAudience takes.
 *
 * `addressHash` narrows the read to one address (the worker's send-time
 * check); null means there is no address, so nothing can apply.
 */
export async function loadAddressSuppressions(
  tx: Prisma.TransactionClient,
  shopId: string,
  addressHash?: string | null,
): Promise<AddressSuppressions> {
  const rows =
    addressHash === null
      ? []
      : await tx.emailAddressSuppression.findMany({
          where: { shopId, ...(addressHash === undefined ? {} : { addressHash }) },
          select: { addressHash: true, kind: true },
        });
  const unsubscribed = new Set<string>();
  const undeliverable = new Set<string>();
  for (const r of rows) {
    if (r.kind === "unsubscribe") unsubscribed.add(r.addressHash);
    else undeliverable.add(r.addressHash);
  }
  return { shopId, unsubscribed, undeliverable };
}
