import { requireOptionalNativeModule } from "expo";

/**
 * Apple Wallet's add-pass sheet, as a JS surface.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: on Android,
 * in an Expo Go session, and in every build made before this module existed,
 * the native half is simply absent. That must read as "this device cannot add
 * passes" and hide the button, not crash a customer's appointment screen on
 * import.
 */
export interface WalletPassNative {
  /** False where Wallet is unavailable or restricted. Never throws. */
  canAddPasses(): boolean;
  /**
   * Download the signed .pkpass at `url` and present Apple's add sheet.
   * Resolves true if Wallet kept it, false if the customer dismissed the
   * sheet. Rejects when the pass could not be offered at all.
   */
  presentPass(url: string): Promise<boolean>;
}

const native = requireOptionalNativeModule<WalletPassNative>("WalletPass");

/** The native module, or null where it does not exist. */
export function walletPassNative(): WalletPassNative | null {
  return native ?? null;
}
