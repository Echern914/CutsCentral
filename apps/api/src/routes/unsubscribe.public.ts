import { Router } from "express";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * ONE CLICK, AND THEY ARE OUT.
 *
 * 🔴 THIS ROUTE IS WHAT MAKES BROADCAST EMAIL LAWFUL TO SEND. A promotional
 * email must carry a working unsubscribe, and the List-Unsubscribe header on
 * the broadcast stream points here. An earlier cut of the email module
 * deliberately sent NO such header, on the grounds that one pointing at a
 * route which does not exist is worse than none - which was right. This is
 * that route.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 *
 * PUBLIC AND UNAUTHENTICATED, by necessity: somebody clicking a link in an
 * email has no session and is not going to make one. The client's magicToken
 * is the authority, exactly as it is for the rewards page - the token IS the
 * identification, and holding it is the proof.
 *
 * NEVER 404s ON A BAD TOKEN. Every request answers the same calm page whether
 * the token is real, spent, or invented. The alternative tells whoever is
 * probing which tokens belong to real people.
 *
 * BOTH VERBS. Gmail and Yahoo send a POST without the human seeing anything
 * (List-Unsubscribe-Post); a person clicking the link sends a GET and needs a
 * page confirming it worked. The POST answers 200 with no body, as the
 * one-click spec requires.
 *
 * 🔴 IT UNSUBSCRIBES FROM MARKETING ONLY. `emailOptedOut` gates broadcasts and
 * nothing else: booking confirmations, reminders and cancellations keep going.
 * Somebody who does not want the shop's promotions has not asked to stop being
 * told when their own appointment is.
 */
export const unsubscribeRouter: Router = Router();

/** Set the flag. Idempotent, and silent about whether the token meant anything. */
async function optOut(token: string): Promise<void> {
  if (!token || token.length > 200) return;
  try {
    // Global token lookup, like the rewards page - it resolves without a shop.
    const { count } = await prisma.client.updateMany({
      where: { magicToken: token, emailOptedOut: false },
      data: { emailOptedOut: true, emailOptedOutAt: new Date() },
    });
    // Correlation only: never the token, never the address.
    if (count > 0) logger.info({ kind: "broadcast" }, "client unsubscribed from emails");
  } catch (err) {
    // A failed write must not answer with an error page: the human would try
    // again, and a provider would read a 500 as a broken unsubscribe.
    logger.error({ err }, "unsubscribe write failed");
  }
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Unsubscribed</title></head>
<body style="margin:0;background:#0A0A0B;color:#F5F5F0;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:28rem;margin:0 auto;padding:4rem 1.5rem;text-align:center">
<h1 style="font-size:1.35rem;margin:0 0 .75rem">You're unsubscribed</h1>
<p style="margin:0 0 .5rem;line-height:1.6;color:#b6b6bb">
You won't get marketing emails from this shop again.</p>
<p style="margin:0;line-height:1.6;color:#8a8a90;font-size:.9rem">
You'll still get confirmations and reminders for appointments you book.</p>
</div></body></html>`;

// The one-click POST mailbox providers send. No body, no redirect.
unsubscribeRouter.post("/:token", async (req, res) => {
  await optOut(String(req.params.token ?? ""));
  res.status(200).end();
});

// A person clicking the link in the footer.
unsubscribeRouter.get("/:token", async (req, res) => {
  await optOut(String(req.params.token ?? ""));
  res.status(200).type("html").send(PAGE);
});
