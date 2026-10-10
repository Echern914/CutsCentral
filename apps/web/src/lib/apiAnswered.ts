/**
 * Did the API actually ANSWER a write, so its outcome is known?
 *
 * 🔴 A 5xx IS NOT "NOTHING HAPPENED". A gateway 502/503/504 comes from the
 * proxy in front of the API, and it can arrive AFTER the API committed - an
 * instance cut off mid-deploy, a slow request the proxy gave up on. The API's
 * own 500 can come from work after the commit too. So only a 2xx or a 4xx (the
 * API's own, deliberate answer) settles a write. No status at all (0: the
 * request never got a response) and any 5xx mean the outcome is UNKNOWN: the
 * caller keeps the same attempt (its operationId) and retries it, and the
 * server answers that retry from whatever the first copy left.
 */
export function apiAnswered(status: number): boolean {
  return status !== 0 && status < 500;
}
