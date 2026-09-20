import { requireOptionalNativeModule } from "expo";

/**
 * Apple's required "How to Tap" overlay, as a JS surface.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: in an Expo Go
 * session, on Android, and in any build made before this module existed, the
 * native half is simply absent. That must read as "this device cannot show
 * Apple's overlay" and fall back, not crash the dashboard on import.
 */
export interface TapToPayEducationNative {
  /** True only on iOS 18+, where ProximityReaderDiscovery exists. */
  isNativeEducationAvailable(): boolean;
  /** Presents Apple's overlay. Rejects if it could not be shown. */
  presentHowToTap(): Promise<boolean>;
}

const native = requireOptionalNativeModule<TapToPayEducationNative>("TapToPayEducation");

/** The native module, or null where it does not exist. */
export function tapToPayEducationNative(): TapToPayEducationNative | null {
  return native ?? null;
}
