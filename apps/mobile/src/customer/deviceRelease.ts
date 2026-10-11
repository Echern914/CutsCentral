import { ApiError, request } from "./api";

/**
 * Taking this phone off a customer account's push - remembered across
 * launches until the server has confirmed it.
 *
 * 🔴 WHAT WAS WRONG. Three ways a signed-out phone stayed registered:
 *  - sign-out swallowed a failed /api/me/devices/remove and signed out anyway,
 *    with nothing left anywhere to try again;
 *  - the token to remove was known only to the registrar, in memory, for a
 *    registration made THIS launch - sign out before Home had registered
 *    again and there was nothing to remove;
 *  - a 401 (a session 60 days old, or revoked) signed out on the spot and
 *    never removed anything at all, since the remove needed a live session.
 *
 * Now the phone remembers the push token the server confirmed, a sign-out
 * writes the removal down BEFORE sending it and crosses it off only once the
 * server has answered, the next launch retries one that didn't land, and the
 * 401 path removes too - through /api/customer-auth/devices/release, which
 * accepts the account's own session token even after it has died.
 */

/** One stored value. Every implementation swallows its storage errors. */
export interface KeyValue {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** A removal the server has not confirmed yet. */
export interface PendingRelease {
  expoPushToken: string;
  /** The account's session token - possibly dead, which the API allows. */
  bearer: string;
}

/** "done": the server answered for good. "retry": try again next launch. */
export type SendOutcome = "done" | "retry";

export interface DeviceRelease {
  /** The server confirmed this token for the signed-in account. */
  registered(expoPushToken: string): Promise<void>;
  /**
   * Take the phone off the account `bearer` speaks for. `expoPushToken` is the
   * one this launch knows, if any; otherwise the remembered one is used.
   */
  release(args: { bearer: string; expoPushToken: string | null }): Promise<SendOutcome | "nothing">;
  /** At launch: send a removal an earlier launch could not. */
  retryPending(): Promise<SendOutcome | "nothing">;
}

function parsePending(raw: string | null): PendingRelease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingRelease> | null;
    if (v && typeof v.expoPushToken === "string" && v.expoPushToken && typeof v.bearer === "string" && v.bearer) {
      return { expoPushToken: v.expoPushToken, bearer: v.bearer };
    }
  } catch {
    /* unreadable: treated as nothing pending */
  }
  return null;
}

export function createDeviceRelease(deps: {
  /** The push token the server last confirmed for this phone. */
  device: KeyValue;
  /** The removal not yet confirmed (JSON PendingRelease). */
  pending: KeyValue;
  send: (release: PendingRelease) => Promise<SendOutcome>;
}): DeviceRelease {
  async function attempt(job: PendingRelease): Promise<SendOutcome> {
    let outcome: SendOutcome;
    try {
      outcome = await deps.send(job);
    } catch {
      outcome = "retry";
    }
    if (outcome === "done") {
      // Only cross off the job we sent: a newer one written meanwhile stays.
      const now = parsePending(await deps.pending.get());
      if (now && now.expoPushToken === job.expoPushToken && now.bearer === job.bearer) {
        await deps.pending.clear();
      }
    }
    return outcome;
  }

  return {
    async registered(expoPushToken) {
      await deps.device.set(expoPushToken);
      // One row per push token on the server: registering it just moved it to
      // the signed-in account, so an older removal of it has nothing left to
      // remove - and sending it now could only take the live sign-in off.
      const old = parsePending(await deps.pending.get());
      if (old && old.expoPushToken === expoPushToken) await deps.pending.clear();
    },

    async release({ bearer, expoPushToken }) {
      const token = expoPushToken ?? (await deps.device.get());
      if (!token || !bearer) return "nothing";
      const job: PendingRelease = { expoPushToken: token, bearer };
      // Written down FIRST: if the app dies or the network drops mid-request,
      // the next launch still knows what to remove.
      await deps.pending.set(JSON.stringify(job));
      await deps.device.clear();
      return attempt(job);
    },

    async retryPending() {
      const job = parsePending(await deps.pending.get());
      if (!job) return "nothing";
      return attempt(job);
    },
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The HTTP half: POST /api/customer-auth/devices/release. Offline, a server
 * error or a rate limit is "retry"; any other answer is final (a 401 means the
 * token was never a customer session, and asking again won't change that).
 */
export function releaseSender(opts: { origin: string; fetchImpl?: FetchLike }) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return async (job: PendingRelease): Promise<SendOutcome> => {
    try {
      await request(fetchImpl, `${opts.origin}/api/customer-auth/devices/release`, {
        method: "POST",
        headers: { Authorization: `Bearer ${job.bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expoPushToken: job.expoPushToken }),
      });
      return "done";
    } catch (err) {
      if (err instanceof ApiError && err.kind !== "offline" && err.kind !== "server" && err.kind !== "rate_limited") {
        return "done";
      }
      return "retry";
    }
  };
}
