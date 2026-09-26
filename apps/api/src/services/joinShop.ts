import { Prisma, runAsOwner } from "@chairback/db";
import { checkTellApart, randomToken } from "@chairback/config";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { logger } from "../logger.js";
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
 *
 * 🔴 A NEW RECORD NEEDS A LAST NAME OR AN INSTAGRAM HANDLE (config
 * clientIdentity.ts), read from the account after the join form saved them.
 * Asked only where a record would be MADE or requested: a customer the shop
 * already knows (linked, or holding a contact on file) is never turned away
 * over a name, and a barber accepting a request is never blocked by one.
 */

export type JoinResult = "joined" | "pending" | "needs_connecting" | "details_required";

const canBeToldApart = (a: { lastName: string | null; instagram: string | null }) =>
  checkTellApart({ lastName: a.lastName, instagram: a.instagram }).ok;

/**
 * Does the shop already hold an ACTIVE record carrying one of the account's
 * proven contacts?
 *
 * 🔴 ACTIVE ONLY - the same eligibility the identity rules use
 * (customerIdentity.ts ELIGIBLE). This used to count archived, merged and
 * erased rows too, which the identity rules never offer to anyone: a customer
 * whose only match was an archived record was told the shop "already has your
 * number" and then shown nothing to connect, and that record's link 404s. A
 * dead end with no way out. An archived record is not reopened by joining
 * either - see becomeClient.
 */
async function contactOnFile(
  shopId: string,
  account: { phoneE164: string | null; emailNormalized: string | null },
): Promise<boolean> {
  const onFile = await runAsOwner((tx) =>
    tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "Client"
       WHERE "shopId" = ${shopId}
         AND "archivedAt" IS NULL
         AND "acuityClientKey" NOT LIKE 'deleted:%'
         AND (("phone" IS NOT NULL AND "phone" = ${account.phoneE164})
           OR ("email" IS NOT NULL AND lower("email") = ${account.emailNormalized}))`),
  );
  return (onFile[0]?.n ?? 0) > 0;
}

/** Make the account a client of the shop now; the shop's approval, if any, is behind us. */
export async function becomeClient(
  accountId: string,
  shopId: string,
  now = new Date(),
  opts: { requireTellApart?: boolean } = {},
): Promise<Exclude<JoinResult, "pending">> {
  const before = await syncCustomerView(accountId, now);
  if (before.links.some((l) => l.shopId === shopId)) return "joined";

  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUnique({
      where: { id: accountId },
      select: { firstName: true, lastName: true, instagram: true, phoneE164: true, emailNormalized: true, isDemo: true },
    }),
  );
  if (!account || account.isDemo || (!account.phoneE164 && !account.emailNormalized)) return "needs_connecting";

  if (await contactOnFile(shopId, account)) return "needs_connecting";
  if (opts.requireTellApart && !canBeToldApart(account)) return "details_required";

  const acuityClientKey = deriveAcuityClientKey({
    phone: account.phoneE164,
    email: account.emailNormalized,
    firstName: account.firstName,
    lastName: account.lastName,
  });
  await runAsOwner(async (tx) => {
    // 🔴 AN ARCHIVED RECORD IS NEVER REOPENED BY JOINING - but it can hold the
    // very key this person derives to (same phone), and the upsert below would
    // then change nothing and link nothing: the other half of the dead end
    // above. Reviving it would hand this account the archived history on the
    // strength of a phone number alone (numbers get recycled) and overrule the
    // shop's decision to archive it. So the archived record gives the key up -
    // re-keyed exactly as a merge re-keys its loser (client.ts: `merged:`) -
    // and stays archived with its history untouched, while the customer gets a
    // fresh record under the key, where their later bookings will land too.
    const holder = await tx.client.findUnique({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey } },
      select: { id: true, archivedAt: true },
    });
    if (holder?.archivedAt) {
      // ONLY the key moves. Its visits, punches, appointments, notes and any
      // merge events naming it (ClientMergeEvent, append-only) stay exactly
      // where they are, and the new key says what happened to the old one.
      await tx.client.update({
        where: { id: holder.id },
        data: { acuityClientKey: `archived:${holder.id}` },
      });
      // Ids only: the phone or email that caused it never reaches a log line.
      logger.info(
        { shopId, archivedClientId: holder.id, accountId },
        "join: archived client released its key to a new record (history untouched)",
      );
    }
    await tx.client.upsert({
      where: { shopId_acuityClientKey: { shopId, acuityClientKey } },
      create: {
        shopId,
        acuityClientKey,
        magicToken: randomToken(),
        firstName: account.firstName?.trim() || "ChairBack customer",
        lastName: account.lastName?.trim() || null,
        instagram: account.instagram,
        phone: account.phoneE164,
        email: account.emailNormalized,
        source: "manual",
      },
      // A raced second join lands here: it changes nothing.
      update: {},
    });
  });

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
    const account = await runAsOwner((tx) =>
      tx.customerAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { lastName: true, instagram: true, phoneE164: true, emailNormalized: true },
      }),
    );
    if (!canBeToldApart(account) && !(await contactOnFile(shop.id, account))) return "details_required";
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

  const result = await becomeClient(accountId, shop.id, now, { requireTellApart: true });
  if (result === "joined") {
    await runAsOwner((tx) => tx.customerSavedShop.deleteMany({ where: { accountId, shopId: shop.id } }));
  }
  return result;
}
