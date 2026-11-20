import { logger } from "../logger.js";
import {
  resolveNotifyPrefs,
  sendToBarber,
  type BarberAlertKind,
  type BarberMessage,
  type BarberSendResult,
  type NotifyPrefs,
} from "./barberNotify.js";

/**
 * WHO AN EVENT ON A CHAIR IS FOR. The one rule; every alert path names an
 * audience rather than deciding for itself.
 *
 *  - "chair"          the person working the chair, else the owner. For news
 *                     only they can use: next up, a tip, a client on the way.
 *  - "chairAndOwner"  that person, PLUS the owner when the owner's "other
 *                     chairs" switch is on. For what happened to the shop's
 *                     calendar: booked, moved, cancelled, walked in.
 *  - "decider"        the OWNER FIRST, always, plus that person as a copy. For
 *                     anything that needs a decision only the owner's side of
 *                     the dashboard can make: a request to approve, a late
 *                     fee to charge or waive, a double-booked chair. The
 *                     owner's switch is deliberately not consulted - it turns
 *                     off news, never something waiting on him.
 *
 * 🔴 WHY THIS EXISTS. Every path used to resolve one recipient as
 * `staff.userId ?? ownerId`. That is right for a solo shop and wrong the
 * moment an owner invites a barber: the owner went blind on that chair, and a
 * booking REQUEST went only to a barber whose login cannot approve it.
 *
 * A chair with no login, or a chair the owner works himself, has one
 * recipient under every audience: the owner. So a one-person shop is exactly
 * as it was, and nobody is ever sent the same event twice.
 *
 * 🔴 WHY ITS OWN FILE. This calls `sendToBarber` through the module boundary
 * on purpose. A dozen suites replace that one export to capture sends; a
 * helper living beside it in barberNotify.ts would call the real function
 * straight past the mock, and every one of those suites would report "alert
 * not sent" for an alert that was.
 */
export type AlertAudience = "chair" | "chairAndOwner" | "decider";

export interface AlertRecipient {
  userId: string;
  prefs: NotifyPrefs;
  /** Is this the shop owner (as opposed to the barber on the chair)? */
  isOwner: boolean;
}

export async function alertRecipients(params: {
  shopId: string;
  ownerId: string;
  /** `Staff.userId` of the chair the event is on. Null/absent = no login. */
  chairUserId: string | null | undefined;
  audience: AlertAudience;
}): Promise<AlertRecipient[]> {
  const { shopId, ownerId, audience } = params;
  const chairUserId = params.chairUserId ?? null;
  const owner = async (): Promise<AlertRecipient> => ({
    userId: ownerId,
    prefs: await resolveNotifyPrefs(shopId, ownerId),
    isOwner: true,
  });
  if (chairUserId === null || chairUserId === ownerId) return [await owner()];

  const chair: AlertRecipient = {
    userId: chairUserId,
    prefs: await resolveNotifyPrefs(shopId, chairUserId),
    isOwner: false,
  };
  if (audience === "chair") return [chair];
  const ownerRow = await owner();
  if (audience === "decider") return [ownerRow, chair];
  return ownerRow.prefs.otherChairsEnabled ? [chair, ownerRow] : [chair];
}

/**
 * Send one event about a chair to everyone it is for (alertRecipients), each
 * through sendToBarber - so each person's own kind and channel switches apply
 * to their own copy, and a phone two of them share is texted once.
 *
 * `message` may be a function when the copy should differ by reader (a link a
 * barber's login cannot open, say). Never throws, like sendToBarber.
 */
export async function sendToChair(params: {
  shopId: string;
  ownerId: string;
  chairUserId: string | null | undefined;
  audience: AlertAudience;
  kind: BarberAlertKind;
  message: BarberMessage | ((to: AlertRecipient) => BarberMessage);
}): Promise<BarberSendResult[]> {
  const results: BarberSendResult[] = [];
  try {
    const recipients = await alertRecipients(params);
    const textedNumbers = new Set<string>();
    for (const to of recipients) {
      results.push(
        await sendToBarber({
          shopId: params.shopId,
          userId: to.userId,
          kind: params.kind,
          prefs: to.prefs,
          textedNumbers,
          message: typeof params.message === "function" ? params.message(to) : params.message,
        }),
      );
    }
  } catch (err) {
    logger.error({ err, shopId: params.shopId, kind: params.kind }, "sendToChair failed");
  }
  return results;
}
