/**
 * WHEN the barber sees Apple's "How to Tap" overlay, and what happens when it
 * cannot be shown.
 *
 * 🔴 APPLE REQUIRES THIS, and it is not ours to design. Stripe's Tap to Pay
 * documentation: "Apple requires you to present a 'How to Tap' instructional
 * overlay when enabling Tap to Pay on iPhone. You must integrate this before
 * submitting your app for review." On iOS 18+ it must be Apple's own content,
 * through ProximityReaderDiscovery - localized for the merchant's region and
 * kept current by Apple. A screen of our own is a FALLBACK for older iOS, never
 * a substitute.
 *
 * 🔴 AT FIRST USE, BEFORE THE FIRST PAYMENT - not during one. Education is
 * shown when the barber first CHOOSES Tap to Pay, which is the "enabling" point
 * Apple's wording describes, and deliberately not at the moment of collecting:
 * Apple's overlay has no dismissal callback, so presenting it while the reader
 * is arming would put an instructional sheet over a live payment with a
 * customer waiting.
 *
 * 🔴 ONLY A SHOWING COUNTS. `markShown` is called after the overlay actually
 * appeared. A failure to present must NOT record it - the record is the only
 * evidence the requirement was met, and a false one means the next barber on
 * that device never sees it at all.
 *
 * This module is pure so the rules above can be tested without an iPhone: the
 * storage and the native call are both injected.
 */

/** Per-device, so each phone that takes payments has shown the education. */
export const EDUCATION_STORAGE_KEY = "cb.tapToPay.howToTapShownAt";

export type EducationOutcome =
  /** Apple's own overlay was presented. The only outcome that satisfies iOS 18+. */
  | "native"
  /** Our instructions were shown instead, on an iOS too old for Apple's API. */
  | "fallback"
  /** Already shown on this device; nothing to do. */
  | "already"
  /** Could not be shown at all. NOT recorded, and the caller must not proceed. */
  | "failed";

export interface EducationResult {
  outcome: EducationOutcome;
  /** Present on `failed`, for the log and the barber-facing message. */
  reason?: string;
}

export interface EducationDeps {
  /** Reads the stored timestamp, or null if never shown. */
  read(): Promise<string | null>;
  /** Records that it was shown. Called ONLY after it actually appeared. */
  write(value: string): Promise<void>;
  /** iOS 18+ with ProximityReaderDiscovery available. */
  nativeAvailable(): boolean;
  /** Presents Apple's overlay. Rejects if it could not be shown. */
  presentNative(): Promise<unknown>;
  /** Shows our own instructions. Resolves when the barber dismisses them. */
  presentFallback(): Promise<void>;
  now?(): Date;
}

/**
 * Show the education if this device has not seen it.
 *
 * Returns `already` on every call after the first, so choosing Tap to Pay for
 * the hundredth time does not put an overlay in front of a waiting customer.
 */
export async function ensureHowToTapShown(deps: EducationDeps): Promise<EducationResult> {
  let seen: string | null = null;
  try {
    seen = await deps.read();
  } catch {
    // Storage is unreadable. Treat as "not shown": showing it twice is a small
    // annoyance, skipping it is an App Review failure and a barber who was
    // never taught how to hold the phone.
    seen = null;
  }
  if (seen) return { outcome: "already" };

  const stamp = (deps.now?.() ?? new Date()).toISOString();

  if (deps.nativeAvailable()) {
    try {
      await deps.presentNative();
    } catch (err) {
      // 🔴 NOT recorded, and NOT downgraded to the fallback. On iOS 18+ Apple's
      // overlay is the requirement; quietly showing our own instead would leave
      // the app shipping without the thing Apple asked for, and nothing would
      // ever say so. The barber is told, and Tap to Pay stays unavailable.
      return { outcome: "failed", reason: message(err) };
    }
    await persist(deps, stamp);
    return { outcome: "native" };
  }

  try {
    await deps.presentFallback();
  } catch (err) {
    return { outcome: "failed", reason: message(err) };
  }
  await persist(deps, stamp);
  return { outcome: "fallback" };
}

async function persist(deps: EducationDeps, stamp: string): Promise<void> {
  try {
    await deps.write(stamp);
  } catch {
    // Shown but not remembered: it will be shown again next time, which is
    // harmless. Failing the collection over a storage write would not be.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
