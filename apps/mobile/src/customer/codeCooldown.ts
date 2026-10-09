/**
 * How long before another code can be sent - per CHANNEL AND CONTACT.
 *
 * 🔴 One shared timer held back the fallback it exists for: a text that never
 * arrived started a 60-second wait, and "Email me a code (48s)" stayed disabled
 * for the rest of it. The server already throttles per (channel, contact), so
 * switching to email - or to a corrected number - may send at once; going back
 * to the same number still waits.
 *
 * Deadlines, not countdowns: a phone that goes to the background stops ticking
 * intervals, and a counter would come back with time it never waited. The
 * server's own throttle stays the real limit; this only spares a refusal.
 */

export const CODE_RESEND_SECONDS = 60;

/** When each key may send again, as epoch milliseconds. */
export type Cooldowns = Readonly<Record<string, number>>;

/** "sms:5555550123" / "email:sam@x.com" - one key per place a code goes. */
export function sendKey(channel: "sms" | "email", contact: string): string {
  const c = contact.trim().toLowerCase();
  return channel === "sms" ? `sms:${c.replace(/\D/g, "").slice(-10)}` : `email:${c}`;
}

export function startCooldown(c: Cooldowns, key: string, now: number, seconds = CODE_RESEND_SECONDS): Cooldowns {
  return { ...c, [key]: now + seconds * 1000 };
}

export function secondsLeft(c: Cooldowns, key: string, now: number): number {
  const until = c[key];
  return until === undefined ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}
