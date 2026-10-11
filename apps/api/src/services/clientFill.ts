import type { Prisma } from "@chairback/db";

/**
 * 🔴 A PHONE ON FILE IS NOT PROOF OF WHO IS BOOKING.
 *
 * Every public booking path finds its client by a key built from the TYPED
 * phone (acuity/clientKey.ts: phone first, then email). Two people who share a
 * number - a partner, a parent booking for a teenager, a family phone - land on
 * ONE client record. Those paths used to overwrite that record's name and
 * email with whatever was typed, so the account holder was renamed after
 * whoever booked last, and a new email address also cleared their
 * marketing-email yes (the address changed - #527's trigger).
 *
 * So public forms only FILL a missing NAME and never replace what is there.
 * Nothing is lost: the booking row itself keeps exactly what was typed
 * (Appointment.firstName / lastName / phone / email), and the confirmation
 * goes to the booking's own email first. Correcting a client's name or email
 * is the barber's job, from the client profile (services/client.ts
 * editClient).
 *
 * 🔴 AND NEVER A CONTACT - not even into a blank. A phone or email on a
 * record is what My ChairBack links an app account by
 * (services/customerIdentity.ts): one record carrying a contact the account
 * proved, nobody else holding it, and the account gets the record's visits,
 * rewards link and manage links. Filling a typed email into a regular's empty
 * email field let a stranger who knew their number book once with it and
 * their own address, sign in with that address, and own the profile. A form
 * nobody signed into proves nothing about the record it lands on, so it adds
 * no way into it. A record the booking CREATES still carries what was typed
 * (the upsert's create) - that record holds nobody's history but the booker's.
 *
 * Each field is its own conditional update, so a blank one fills even when
 * the other is already set, and a set one is never touched.
 */
export async function fillBlankClientNames(
  db: Pick<Prisma.TransactionClient, "client">,
  clientId: string,
  typed: {
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<void> {
  const blank = (field: "firstName" | "lastName") => ({
    id: clientId,
    OR: [{ [field]: null }, { [field]: "" }],
  });
  const firstName = typed.firstName?.trim();
  const lastName = typed.lastName?.trim();
  if (firstName) await db.client.updateMany({ where: blank("firstName"), data: { firstName } });
  if (lastName) await db.client.updateMany({ where: blank("lastName"), data: { lastName } });
}
