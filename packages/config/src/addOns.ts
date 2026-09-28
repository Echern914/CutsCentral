/**
 * WHICH ADD-ONS GO WITH WHICH SERVICE - the one rule.
 *
 * An add-on lists the services it is offered with. An EMPTY list means every
 * service (a hot towel that goes with anything); a non-empty one means only
 * those. Three places have to agree on that, so it lives here once:
 *
 *   - the API, when it prices and lengthens a booking (engines/addOns.ts
 *     `resolveAddOns`) - the rule that decides what is charged;
 *   - the customer's booking page, when it lists the choices;
 *   - the barber's New appointment form, when it lists the choices.
 *
 * If a form listed an add-on the API will not honour, the barber or customer
 * would see a total the booking does not carry.
 *
 * Pure: no I/O - it is imported by client components.
 */

/** The slice of an add-on this rule reads. */
export interface AddOnScope {
  /** [] = offered with every service; otherwise only with these. */
  serviceIds: readonly string[];
}

/** Is this add-on offered with this service? */
export function addOnOffersService(addOn: AddOnScope, serviceId: string): boolean {
  return addOn.serviceIds.length === 0 || addOn.serviceIds.includes(serviceId);
}
