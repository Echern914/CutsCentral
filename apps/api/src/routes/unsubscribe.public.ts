import { Router } from "express";
import { runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { unsubscribeTokenDigest } from "../engines/unsubscribeToken.js";
import {
  recordEmailMarketingYes,
  unsubscribeFromMarketingEmail,
} from "../services/emailMarketingConsent.js";

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
 * ── The credential ──────────────────────────────────────────────────────────
 *
 * 🔴 IT IS NOT THE REWARDS TOKEN. The first cut put `Client.magicToken` in the
 * footer, which is that customer's entire rewards session - their visits,
 * punches, appointments and settings - mailed out to a few thousand people
 * every time a shop ran a promotion, through forwarding, screenshots, shared
 * inboxes and every link scanner in between. What this accepts instead grants
 * `emailOptedOut = true` and NOTHING ELSE: it cannot open the rewards page,
 * read an appointment, or be exchanged for anything that can. See
 * engines/unsubscribeToken.ts.
 *
 * The lookup is by DIGEST, so the database stores no usable link. The token
 * itself is derived and stable, which is what lets an unsubscribe in a
 * three-week-old email still work - a freshly minted token per send would
 * break every earlier one, and CAN-SPAM requires the opposite.
 *
 * ── The rest of the design ──────────────────────────────────────────────────
 *
 * PUBLIC AND UNAUTHENTICATED, by necessity: somebody clicking a link in an
 * email has no session and is not going to make one.
 *
 * THE UNSUBSCRIBE NEVER 404s ON A BAD TOKEN (the Resubscribe button further
 * down does refuse one, because claiming success there would be a lie). Every
 * unsubscribe answers the same calm page whether
 * the token is real, spent, or invented. The alternative tells whoever is
 * probing which tokens belong to real people.
 *
 * 🔴 BUT A FAILED WRITE IS NOT A BAD TOKEN, and must not borrow its answer.
 * An earlier cut caught database errors and still rendered "You're
 * unsubscribed". Somebody reads that, believes it, and the next promotion
 * arrives anyway - at which point they do not click unsubscribe again, they
 * press "this is spam", which costs the shop and the sending domain far more
 * than a moment of honesty would have. A failure now answers 503: retryable,
 * carrying no customer information, and identical for every token, so the
 * outage cannot be used to tell real tokens from invented ones.
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

/**
 * Two outcomes, and only two.
 *
 * 🔴 "settled" DOES NOT MEAN "a row changed". It means the database answered:
 * the person is now opted out, or was already, or the token never meant
 * anything. All three are indistinguishable on purpose - that is what stops
 * this being a token oracle.
 *
 * "unavailable" means we do not know, because the write itself failed. It is a
 * different fact and it gets a different answer.
 */
type OptOutResult = "settled" | "unavailable";

/** Set the flag. Idempotent, and silent about whether the token meant anything. */
async function optOut(token: string): Promise<OptOutResult> {
  // Nothing this shape can be a real token, so there is nothing to look up -
  // and answering exactly as an unknown token does keeps the two cases
  // indistinguishable.
  if (!token || token.length > 200) return "settled";
  try {
    // Global digest lookup: an unsubscribe link resolves before any shop is
    // known, exactly as the rewards page does - but on a credential that can
    // do only this.
    const count = await runAsOwner(async (tx) => {
      const client = await tx.client.findUnique({
        where: { unsubscribeTokenHash: unsubscribeTokenDigest(token) },
        select: { id: true, shopId: true, email: true },
      });
      if (!client) return 0;
      // The flag AND the address (#514), in this transaction - the same write
      // as the customer's own switch on their rewards page
      // (services/emailMarketingConsent.ts).
      return unsubscribeFromMarketingEmail(tx, client, "unsubscribe_link");
    });
    // Correlation only: never the token, never the address.
    if (count > 0) logger.info({ kind: "broadcast" }, "client unsubscribed from emails");
    return "settled";
  } catch (err) {
    // 🔴 A CLASSIFICATION ONLY - a driver error carries the statement it
    // failed on, and the parameter of this one is the token digest.
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown", reason: "unsubscribe_write_failed" },
      "unsubscribe could not be recorded",
    );
    return "unavailable";
  }
}

/** The calm page every answer here uses. */
function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title></head>
<body style="margin:0;background:#0A0A0B;color:#F5F5F0;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:28rem;margin:0 auto;padding:4rem 1.5rem;text-align:center">
${body}
</div></body></html>`;
}

/**
 * "You're unsubscribed", with a way back.
 *
 * 🔴 RESUBSCRIBE IS A BUTTON THAT POSTS - never something this GET does, and
 * never a link. Mailbox scanners and previewers open every URL in a message;
 * that is harmless for an unsubscribe (it errs toward sending less) but a
 * scanner must never be able to switch marketing email back ON. Only a person
 * pressing the button sends the POST. The token is URL-encoded, which also
 * makes it safe inside the attribute. Identical for every token, like the
 * unsubscribe itself.
 */
function page(token: string): string {
  return shell(
    "Unsubscribed",
    `<h1 style="font-size:1.35rem;margin:0 0 .75rem">You're unsubscribed</h1>
<p style="margin:0 0 .5rem;line-height:1.6;color:#b6b6bb">
You won't get marketing emails from this shop again.</p>
<p style="margin:0;line-height:1.6;color:#8a8a90;font-size:.9rem">
You'll still get confirmations and reminders for appointments you book.</p>
<form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}/resubscribe" style="margin:2rem 0 0">
<p style="margin:0 0 .5rem;line-height:1.6;color:#8a8a90;font-size:.9rem">Changed your mind?</p>
<button type="submit" style="font:inherit;font-size:.9rem;padding:.55rem 1.25rem;border-radius:999px;border:1px solid #3a3a40;background:transparent;color:#F5F5F0;cursor:pointer">Resubscribe</button>
</form>`,
  );
}

const RESUBSCRIBED_PAGE = shell(
  "Subscribed again",
  `<h1 style="font-size:1.35rem;margin:0 0 .75rem">You're subscribed again</h1>
<p style="margin:0;line-height:1.6;color:#b6b6bb">
You'll get news and offers from this shop by email again. You can unsubscribe anytime.</p>`,
);

/**
 * A resubscribe that could not happen: an unknown token, or a record with no
 * address left to send to. Said plainly rather than dressed as success - a
 * page claiming "subscribed again" when nothing changed is a lie. The two
 * causes answer identically, and a real token cannot be guessed.
 */
const RESUBSCRIBE_REFUSED_PAGE = shell(
  "Link not recognised",
  `<h1 style="font-size:1.35rem;margin:0 0 .75rem">We couldn't turn emails back on</h1>
<p style="margin:0;line-height:1.6;color:#b6b6bb">
This link can't be used to subscribe again. Nothing was changed.</p>`,
);

const RESUBSCRIBE_UNAVAILABLE_PAGE = shell(
  "Try that again",
  `<h1 style="font-size:1.35rem;margin:0 0 .75rem">We couldn't do that just now</h1>
<p style="margin:0;line-height:1.6;color:#b6b6bb">
Something went wrong on our end, so you have <strong>not</strong> been subscribed again yet. Please try again in a few minutes.</p>`,
);

/**
 * The person pressing Resubscribe: lift their unsubscribe and record their yes
 * ("unsubscribe_page") - the one door allowed to undo an unsubscribe, because
 * only the mailbox the link was sent to has this token. As the connection
 * owner, like the unsubscribe: the address's unsubscribe row is deleted, and
 * the app role has no DELETE there.
 */
async function resubscribe(token: string): Promise<"resubscribed" | "refused" | "unavailable"> {
  if (!token || token.length > 200) return "refused";
  try {
    const outcome = await runAsOwner(async (tx) => {
      const client = await tx.client.findUnique({
        where: { unsubscribeTokenHash: unsubscribeTokenDigest(token) },
        select: { id: true, email: true },
      });
      if (!client) return "refused" as const;
      const result = await recordEmailMarketingYes(tx, {
        clientId: client.id,
        address: client.email,
        source: "unsubscribe_page",
        liftUnsubscribe: true,
      });
      return result === "recorded" || result === "already" ? ("resubscribed" as const) : ("refused" as const);
    });
    // Correlation only: never the token, never the address.
    if (outcome === "resubscribed") logger.info({ kind: "broadcast" }, "client resubscribed to emails");
    return outcome;
  } catch (err) {
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown", reason: "resubscribe_write_failed" },
      "resubscribe could not be recorded",
    );
    return "unavailable";
  }
}

/**
 * 🔴 THE HONEST FAILURE PAGE.
 *
 * The alternative is the page above, shown to somebody whose flag was never
 * set: they read "You're unsubscribed", believe it, and the next promotion
 * arrives anyway. At that point they do not click unsubscribe again - they
 * press "this is spam", which is worse for them, worse for the shop, and worse
 * for every other shop sending from this domain.
 *
 * It says nothing about the token: identical whether it was real, spent or
 * invented, exactly like the success page, so a failing database does not
 * become an enumeration oracle.
 */
const UNAVAILABLE_PAGE = shell(
  "Try that again",
  `<h1 style="font-size:1.35rem;margin:0 0 .75rem">We couldn't do that just now</h1>
<p style="margin:0 0 .5rem;line-height:1.6;color:#b6b6bb">
Something went wrong on our end, so you have <strong>not</strong> been unsubscribed yet.</p>
<p style="margin:0;line-height:1.6;color:#8a8a90;font-size:.9rem">
Please use the same link again in a few minutes.</p>`,
);

// The one-click POST mailbox providers send. No body, no redirect.
unsubscribeRouter.post("/:token", async (req, res) => {
  if ((await optOut(String(req.params.token ?? ""))) === "unavailable") {
    // Retryable, and honest. Gmail and Yahoo retry a 503 and keep the
    // one-click working; a 200 here would retire their only retry for a
    // request that changed nothing, and the person would go on receiving mail
    // they had told us twice to stop.
    res.status(503).end();
    return;
  }
  res.status(200).end();
});

// A person clicking the link in the footer.
unsubscribeRouter.get("/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  if ((await optOut(token)) === "unavailable") {
    res.status(503).type("html").send(UNAVAILABLE_PAGE);
    return;
  }
  res.status(200).type("html").send(page(token));
});

// The Resubscribe button on that page. POST ONLY: no GET is registered for
// this path, so a scanner following URLs cannot reach it.
unsubscribeRouter.post("/:token/resubscribe", async (req, res) => {
  const outcome = await resubscribe(String(req.params.token ?? ""));
  if (outcome === "unavailable") {
    res.status(503).type("html").send(RESUBSCRIBE_UNAVAILABLE_PAGE);
    return;
  }
  if (outcome === "refused") {
    res.status(404).type("html").send(RESUBSCRIBE_REFUSED_PAGE);
    return;
  }
  res.status(200).type("html").send(RESUBSCRIBED_PAGE);
});
