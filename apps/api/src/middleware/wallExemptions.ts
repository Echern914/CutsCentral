import type { Request } from "express";

/**
 * The holes in the wall, in one place.
 *
 * A lapsed shop can still READ and EXPORT its own client book. Everything else
 * under /api/dashboard - nudging, sweeps, imports, edits, waitlist, reviews,
 * receptionist - is walled with the rest of the product.
 *
 * 🔑 GET-ONLY, deliberately. `POST /clients/:id/visits` and friends look like
 * "their own data" too, but they are the product working. The test for whether
 * something belongs here is not "is it about a client" - it is "would refusing
 * this leave a barber unable to get their own list out of ChairBack".
 *
 * Paths here are what Express leaves in `req.path` AFTER the /api/dashboard
 * mount is stripped, so they start at /clients, not /api/dashboard/clients.
 */
const READABLE = [
  /^\/clients\/?$/,
  /^\/clients\/[^/]+\/?$/,
  /^\/clients\/[^/]+\/ledger\/?$/,
  /^\/export\/[^/]+\.csv$/,
] as const;

export function isOwnDataRead(req: Request): boolean {
  if (req.method !== "GET") return false;
  return READABLE.some((re) => re.test(req.path));
}
