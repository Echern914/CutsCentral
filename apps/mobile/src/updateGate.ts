/**
 * "Is this build too old to run?" - the decision, kept free of react-native so
 * it is tested (src/UpdateRequired.tsx is the thin wiring over it).
 *
 * The API names the oldest iOS build still allowed (GET /api/app-version,
 * driven by IOS_MINIMUM_BUILD on Railway). A build below it covers itself with
 * "Update ChairBack" until the customer updates.
 *
 * 🔴 EVERY DOUBT RESOLVES TO "CARRY ON". No network, a slow or broken API, an
 * API from before this route existed, an answer that doesn't parse, a build
 * number we can't read - none of them may lock anyone out of the app. Only a
 * clear "your build is below the minimum" does.
 */

/** App Store listing. Pinned to MOBILE_APP.appStoreUrl in @chairback/config by the test. */
export const APP_STORE_URL = "https://apps.apple.com/app/id6783995804";

/** Pinned to its mount in apps/api/src/app.ts by the test. */
export const APP_VERSION_PATH = "/api/app-version";

/** Shorter than the API client's 15s: this runs on every launch, unseen. */
export const CHECK_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function wholeNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * True only when both numbers are readable and this build is below the
 * minimum. `currentBuild` is CFBundleVersion ("49"); `answer` is the API's
 * JSON body.
 */
export function mustUpdate(currentBuild: unknown, answer: unknown): boolean {
  const current = wholeNumber(currentBuild);
  const minimum =
    answer && typeof answer === "object"
      ? wholeNumber((answer as { iosMinimumBuild?: unknown }).iosMinimumBuild)
      : null;
  if (current === null || minimum === null) return false;
  return current < minimum;
}

/**
 * Ask the API. `true`/`false` is the answer; `null` means we could not tell,
 * and the caller keeps whatever it last knew (initially: carry on).
 */
export async function checkForRequiredUpdate(
  fetchImpl: FetchLike,
  apiOrigin: string,
  currentBuild: unknown,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiOrigin}${APP_VERSION_PATH}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return mustUpdate(currentBuild, await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
