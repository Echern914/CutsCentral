import { apiEnv } from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import { settleClientLinks } from "./customerIdentity.js";

/**
 * The name a customer gave themselves in My ChairBack, for the shop records
 * they are PROVEN to be.
 *
 * 🔴 SHOWN BESIDE THE SHOP'S NAME, NEVER COPIED INTO IT. A client's name on the
 * shop's side belongs to the shop and to its sync source: Acuity and Square
 * rewrite it on every ingest, and a barber may have typed it by hand. So this
 * is a second, read-only fact about the record ("Name in their app: ..."), and
 * it stands in for the shop's name only where the shop has none at all.
 *
 * 🔴 RE-DERIVED BEFORE IT IS SHOWN. A link is only as current as the record's
 * contact: a barber correcting a phone number, a record being archived, or a
 * second person proving the same number all change whose record this is, and
 * none of that happens on the customer's own device. A name read from a stale
 * link would put one person's name on another person's record, so the links
 * are settled first - the rule the push path already follows. Only ACTIVE links
 * count: an ambiguous record (a shared phone) names nobody, and neither does
 * one the customer disowned.
 *
 * Dark with the feature. While CUSTOMER_ACCOUNTS_ENABLED is off no account can
 * exist to name anyone, so this does no work at all.
 */
export async function appNamesForClients(
  shopId: string,
  clientIds: readonly string[],
  now = new Date(),
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!apiEnv().CUSTOMER_ACCOUNTS_ENABLED || clientIds.length === 0) return names;
  const ids = [...new Set(clientIds)];

  const links = await runAsOwner(async (tx) => {
    await settleClientLinks(tx, ids, now);
    return tx.customerClientLink.findMany({
      where: { shopId, clientId: { in: ids }, status: "active" },
      select: {
        clientId: true,
        account: { select: { firstName: true, lastName: true, isDemo: true } },
      },
    });
  });

  for (const link of links) {
    if (link.account.isDemo) continue;
    const full = [link.account.firstName, link.account.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ");
    if (full) names.set(link.clientId, full);
  }
  return names;
}
