import { NEXT_UP_APP_GROUP, NEXT_UP_WIDGET_ENABLED } from "@/src/config";
import type { WidgetStore } from "@/src/nextUpWidget";

/**
 * The real widget store: @bacons/apple-targets' ExtensionStorage, which writes
 * UserDefaults(suiteName: <App Group>) - the same suite the widget's Swift
 * reads (targets/next-up/NextUpWidget.swift) - and reloads its timeline.
 *
 * Null in a build without the widget (its flag off: no App Group, no target),
 * on Android, and anywhere the native module isn't linked, so callers simply
 * skip the widget there.
 */
let cached: WidgetStore | null | undefined;

export function nextUpWidgetStore(): WidgetStore | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (!NEXT_UP_WIDGET_ENABLED) return cached;
  try {
    // Required lazily: the module is native, and must not be touched in a
    // build (or a test) that doesn't have it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ExtensionStorage } = require("@bacons/apple-targets") as typeof import("@bacons/apple-targets");
    const storage = new ExtensionStorage(NEXT_UP_APP_GROUP);
    cached = {
      set: (key, value) => storage.set(key, value),
      remove: (key) => storage.remove(key),
      reload: () => ExtensionStorage.reloadWidget(),
    };
  } catch {
    cached = null;
  }
  return cached;
}
