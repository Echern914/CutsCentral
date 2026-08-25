import { MirrorNotConfiguredError } from "./acuityMirror.js";
import { SquareMirrorNotConfiguredError } from "./squareMirror.js";

/**
 * "This shop is ENFORCING, and this chair cannot be mirrored."
 *
 * Both outbound mirrors throw when an enforcing shop tries to book a chair they
 * cannot protect, and both throw from INSIDE the booking transaction, on
 * purpose: confirming a booking the external calendar will still show as free
 * is the exact state the mirror exists to prevent.
 *
 * Deliberately loud is only half a design though. Loud and UNCAUGHT is a 500,
 * and a 500 tells the barber nothing, tells the customer less, and looks like
 * the product is broken rather than like the slot is unavailable.
 *
 * 🔴 Before this existed, exactly ONE of the seven paths that record a mirror
 * intent caught either error - the public booking page, and only for Acuity.
 * Every other path (dashboard create, walk-in, waitlist claim, recurring
 * series, receptionist) answered a 500. That was not theoretical: Acuity is
 * live in ENFORCE on a real shop, so adding a barber without mapping their
 * calendar broke booking on five paths at once.
 *
 * Matching on the error rather than on `err.name` because both classes are
 * real exports and `instanceof` survives a rename; matching BOTH mirrors in
 * one predicate because a caller that handles one and forgets the other is the
 * bug this file is here to make impossible.
 */
export type AnyMirrorNotConfiguredError =
  | MirrorNotConfiguredError
  | SquareMirrorNotConfiguredError;

export function isMirrorNotConfigured(err: unknown): err is AnyMirrorNotConfiguredError {
  return (
    err instanceof MirrorNotConfiguredError || err instanceof SquareMirrorNotConfiguredError
  );
}

/** Which mirror refused, for the log line. Never shown to a customer. */
export function mirrorNotConfiguredSource(err: AnyMirrorNotConfiguredError): "acuity" | "square" {
  return err instanceof SquareMirrorNotConfiguredError ? "square" : "acuity";
}
