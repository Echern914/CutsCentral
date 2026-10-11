/**
 * Service pricing and the time-of-day / weekday / per-date layers.
 *
 * 🔴 THE CODE LIVES IN @chairback/config/servicePricing. The booking page has to
 * resolve a slot's price with the SAME function the booking write snapshots onto
 * priceAtBooking, and a second copy of the layer order in the page is exactly
 * how holiday prices came to be booked at one figure and shown at another. This
 * module only re-exports it, so every existing server import keeps working.
 */
export * from "@chairback/config/servicePricing";
