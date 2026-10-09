import type { ApiResult } from "./api";

/**
 * Did an OLDER API refuse this request only because it carried a field it
 * does not know yet?
 *
 * The web (Vercel) and the API (Railway) deploy separately, so for a few
 * minutes after a merge a new screen can be talking to the API it was written
 * BEFORE. That API's `.strict()` schema answers a new optional field with
 * `400 invalid_input` and a zod "Unrecognized key(s)" issue - and writes
 * nothing. The caller can then resend without those fields and get exactly the
 * behaviour the screen had before, instead of a dead button for the length of
 * the deploy.
 *
 * Only ever true for the named keys: any other refusal is a real one.
 */
export function refusedOnlyNewKeys(
  res: Pick<ApiResult<unknown>, "status" | "error" | "issues">,
  newKeys: readonly string[],
): boolean {
  if (res.status !== 400 || res.error !== "invalid_input" || !res.issues?.length) return false;
  return res.issues.every((issue) => {
    if (!issue.message.startsWith("Unrecognized key")) return false;
    const named = [...issue.message.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    return named.length > 0 && named.every((k) => newKeys.includes(k));
  });
}
