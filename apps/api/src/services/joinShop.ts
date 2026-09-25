import { Prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { syncCustomerView } from "./customerIdentity.js";

/**
 * "Join shop": a customer becomes a shop's client from the app.
 *
 * 🔴 ONLY PROVEN CONTACTS. The client record gets the names the customer gave
 * for this shop and the phone and email their account VERIFIED by code, never
 * a typed one. A typed number could be anybody's: the shop would text a
 * stranger, and whoever really owns that number would find this person's
 * visits in their own account the day they signed in with it.
 *
 * 🔴 NEVER A SECOND RECORD. When the shop already holds a record carrying one
 * of those contacts, joining creates nothing. Whether that record is theirs to
 * open is the identity rules' call (customerIdentity.settleClientLinks), the
 * same call sign-in makes - so joining can never open a record sign-in would
 * not, and never writes over one somebody else may own.
 */

export type JoinResult = "joined" | "pending" | "needs_connecting";

/** Make the account a client of the shop now; the shop's approval, if any, is behind us. */
export async function becomeClient(accountId: string, shopId: string, now = new Date()): Promise<Exclude<JoinResult, "pending">> {
  const before = await syncCustomerView(accountId, now);
  if (before.links.some((l) => l.shopId === shopId)) return "joined";

  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUnique({
      where: { id: accountId },
      select: { firstName: true, lastName: true, phoneE164: true, emailNormalized: true, isDemo: true },
    }),
  );
  if (!account || account.isDemo || (!account.phoneE164 && !account.emailNormalized)) return "needs_connecting";

  const onFile = await runAsOwner((tx) =>
    tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "Client"
       WHERE "shopId" = ${shopId}
         AND (("phone" IS NOT NULL AND "phone" = ${account.phoneE164})
           OR ("email" IS NOT NULL AND lower("email") = ${account.emailNormalized}))`),
  );
  if ((onFile[0]?.n ?? 0) > 0) return "needs_connecting";

  const acuityClientKey = deriveAcuityClientKey({
    phone: account.phoneE164,
    email: account.emailNormalized,
    firstName: account.firstName,
    lastName: account.lastName,
  });
  await runAsOwner((tx) =>
    tx.client.upsert({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey } },
      create: {
        shopId,
        acuityClientKey,
        magicToken: randomToken(),
        firstName: account.firstName?.trim() || "ChairBack customer",
        lastName: account.lastName?.trim() || null,
        phone: account.phoneE164,
        email: account.emailNormalized,
        source: "manual",
      },
      // A raced second join lands here: it changes nothing.
      update: {},
    }),
  );

  const after = await syncCustomerView(accountId, now);
  return after.links.some((l) => l.shopId === shopId) ? "joined" : "needs_connecting";
}

/**
 * Join now, or ask to. A shop that approves new clients gets a request (the
 * saved-shop row, marked) and the customer waits; any other shop takes them at
 * once. Either way a plain save of this shop is superseded.
 */
export async function joinShop(
  accountId: string,
  shop: { id: string; approveNewClients: boolean },
  now = new Date(),
): Promise<JoinResult> {
  if (shop.approveNewClients) {
    const view = await syncCustomerView(accountId, now);
    if (view.links.some((l) => l.shopId === shop.id)) return "joined";
    await runAsOwner(async (tx) => {
      await tx.customerSavedShop.upsert({
        where: { accountId_shopId: { accountId, shopId: shop.id } },
        create: { accountId, shopId: shop.id, joinRequestedAt: now },
        update: {},
      });
      // A plain save becomes a request; a request keeps its first date.
      await tx.customerSavedShop.updateMany({
        where: { accountId, shopId: shop.id, joinRequestedAt: null },
        data: { joinRequestedAt: now },
      });
    });
    return "pending";
  }

  const result = await becomeClient(accountId, shop.id, now);
  if (result === "joined") {
    await runAsOwner((tx) => tx.customerSavedShop.deleteMany({ where: { accountId, shopId: shop.id } }));
  }
  return result;
}
