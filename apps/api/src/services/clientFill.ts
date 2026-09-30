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
 * So public forms only FILL what is missing and never replace what is there.
 * Nothing is lost: the booking row itself keeps exactly what was typed
 * (Appointment.firstName / lastName / email), and the confirmation goes to the
 * booking's own email first. Correcting a client's name or email is the
 * barber's job, from the client profile (services/client.ts editClient).
 *
 * Each field is its own conditional update, so a blank one fills even when
 * another is already set, and a set one is never touched.
 */
export async function fillBlankClientFields(
  db: Pick<Prisma.TransactionClient, "client">,
  clientId: string,
  typed: {
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    email?: string | null;
  },
): Promise<void> {
  const blank = (field: "firstName" | "lastName" | "phone" | "email") => ({
    id: clientId,
    OR: [{ [field]: null }, { [field]: "" }],
  });
  const firstName = typed.firstName?.trim();
  const lastName = typed.lastName?.trim();
  const phone = typed.phone?.trim();
  const email = typed.email?.trim();
  if (firstName) await db.client.updateMany({ where: blank("firstName"), data: { firstName } });
  if (lastName) await db.client.updateMany({ where: blank("lastName"), data: { lastName } });
  if (phone) await db.client.updateMany({ where: blank("phone"), data: { phone } });
  if (email) await db.client.updateMany({ where: blank("email"), data: { email } });
}
