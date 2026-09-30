/**
 * A service a CLIENT may be offered: active, and not hidden by the barber
 * (config/serviceVisibility.ts). Spread into every client-facing service read
 * AND write - the booking page and its create, group booking, the walk-in
 * kiosk, the texting receptionist - so what a client can see and what they
 * can book are the same rule.
 *
 * 🔴 NOT IN THE SLOT ENGINE. computeOpenSlots also serves the barber's own
 * dashboard (where a hidden service is bookable) and a client moving an
 * appointment they already have (which stays theirs to move). The gate is at
 * the client-facing route, never underneath it.
 */
export const PUBLIC_SERVICE = { active: true, visibility: "public" } as const;
