import { MirrorNotConfiguredError } from "./acuityMirror.js";

/**
 * "This shop is ENFORCING, and this chair cannot be mirrored."
 *
 * The outbound mirror throws when an enforcing shop tries to book a chair it
 * cannot protect, and it throws from INSIDE the booking transaction, on
 * purpose: confirming a booking the external calendar will still show as free
 * is the exact state the mirror exists to prevent.
 *
 * Deliberately loud is only half a design though. Loud and UNCAUGHT is a 500,
 * and a 500 tells the barber nothing, tells the customer less, and looks like
 * the product is broken rather than like the slot is unavailable.
 *
 * 🔴 Before this existed, exactly ONE of the six paths that record a mirror
 * intent caught it: the public booking page. Every other path - dashboard
 * create, walk-in, waitlist claim, recurring series, receptionist - answered a
 * 500. That is not theoretical: Acuity is live in ENFORCE on a real shop, so
 * adding a barber without mapping their calendar breaks booking on five paths
 * at once.
 *
 * Matching on the error rather than on `err.name` because the class is a real
 * export and `instanceof` survives a rename.
 *
 * 🔑 WHY A PREDICATE FOR A SINGLE ERROR. The Square mirror throws its own
 * version of this, from the same place, and it is coming. Every caller here
 * already asks "is this a chair we cannot mirror" rather than "is this
 * Acuity's error", so the day the second mirror lands the change is one arm in
 * this function instead of six call sites - and a caller that handles one
 * mirror and forgets the other cannot exist.
 */
export function isMirrorNotConfigured(err: unknown): err is MirrorNotConfiguredError {
  return err instanceof MirrorNotConfiguredError;
}

/** Which mirror refused, for the log line. Never shown to a customer. */
export function mirrorNotConfiguredSource(_err: MirrorNotConfiguredError): "acuity" {
  return "acuity";
}
