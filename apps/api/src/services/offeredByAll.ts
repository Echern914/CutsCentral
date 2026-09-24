import { runWithShop } from "@chairback/db";

/**
 * The other half of "offered by all": when a staff member becomes active (created,
 * or reactivated), link them to every offeredByAll service so "all" stays live.
 * Idempotent - skipDuplicates guards the (serviceId, staffId) unique. This is what
 * makes offeredByAll dynamic for barbers added AFTER a service was created.
 *
 * Shared by every place a chair comes into being: the Booking → Staff editor and
 * the Team page's "new chair for this person".
 */
export async function linkStaffToOfferedByAllServices(
  shopId: string,
  staffId: string,
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    const services = await tx.service.findMany({
      where: { shopId, offeredByAll: true },
      select: { id: true },
    });
    if (services.length === 0) return;
    await tx.serviceStaff.createMany({
      data: services.map((s) => ({ shopId, serviceId: s.id, staffId })),
      skipDuplicates: true,
    });
  });
}
