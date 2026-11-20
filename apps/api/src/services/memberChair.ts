import { vocabularyForShop } from "@chairback/config";
import type { Prisma } from "@chairback/db";

/**
 * A CHAIR FOR SOMEONE ON THE TEAM - the one way a login gets a chair made for
 * it, shared by the two places that do it:
 *
 *  - the Team page's "+ New chair for them" (routes/team.ts), and
 *  - accepting an invitation that named no chair (routes/teamJoin.ts).
 *
 * Before the second one existed, the invitation said "you get your own chair"
 * and the person who accepted landed on a screen telling them to ask the owner
 * to link one. The owner then had to notice, open Team, and make it. Adding
 * someone now always ends with a chair they can be booked on.
 *
 * This file makes the chair ROW only. The seat write and the Staff.userId
 * mirror (services/staffUserLink.ts) stay with each caller, because one is
 * updating a seat that exists and the other is creating it - and both must
 * happen in the caller's own transaction. Offering the new chair for every
 * "offered by all" service (services/offeredByAll.ts) happens AFTER that
 * transaction commits, exactly as it does for Add staff.
 */

type ShopWords = Parameters<typeof vocabularyForShop>[0];

/** A public chair name from a person's name - never an email address. */
export function chairName(personName: string | null | undefined, shop: ShopWords): string {
  const name = (personName ?? "").trim();
  if (name && !name.includes("@")) return name.slice(0, 120);
  const noun = vocabularyForShop(shop).providerNoun;
  return `New ${noun}`;
}

/**
 * Make an active chair named after this person, inside the caller's
 * transaction. Returns the new chair's id.
 */
export async function createChairForPerson(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    shop: ShopWords;
    person: { name: string | null | undefined; avatarUrl: string | null | undefined };
  },
): Promise<string> {
  const chair = await tx.staff.create({
    data: {
      shopId: input.shopId,
      // The chair's name is PUBLIC (the booking page). Some accounts carry an
      // email address as their name (Apple sign-in without a name), and that
      // must never be published - the owner renames it under Staff.
      name: chairName(input.person.name, input.shop),
      // Only an http(s) photo, the same boundary the staff editor enforces.
      imageUrl:
        input.person.avatarUrl && /^https?:\/\//i.test(input.person.avatarUrl)
          ? input.person.avatarUrl
          : null,
      active: true,
    },
    select: { id: true },
  });
  return chair.id;
}
