import { Router, type Request } from "express";
import { z } from "zod";
import { runAsOwner } from "@chairback/db";
import { toE164 } from "../acuity/clientKey.js";
import { mintCustomerSession } from "../auth/customerSession.js";
import { customerAuthLimiter } from "../middleware/rateLimit.js";
import { requireCustomerAccounts } from "../middleware/requireCustomer.js";
import {
  normalizeEmail,
  normalizeSignInPhone,
  requestSignInCode,
  verifySignInCode,
  type SignInChannel,
} from "../services/customerSignIn.js";
import { accountForProof, demoAccount, syncCustomerLinks } from "../services/customerIdentity.js";

/**
 * My ChairBack sign-in: send a code, check a code, get a session.
 *
 * Nothing here says whether a phone or email is known. "Send" answers ok for
 * every identifier it can parse; "check" answers {verified:false} for every
 * way a code can fail. The only refusals are about FORMAT (a malformed email,
 * a number we cannot text), which the caller already knows.
 *
 * Codes and contacts travel in POST bodies only - never a URL - so no
 * logRedaction entry is needed, and nothing person-shaped is logged from here.
 */
export const customerAuthRouter: Router = Router();
customerAuthRouter.use(requireCustomerAccounts);

function callerIp(req: Request): string {
  return req.ip ?? "unknown";
}

const identifierSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("sms"), phone: z.string().min(1).max(40) }),
  z.object({ channel: z.literal("email"), email: z.string().min(1).max(254) }),
]);

type Resolved = { channel: SignInChannel; identifier: string } | { error: string };

/** Normalize the typed contact, or name the format problem. */
export function resolveIdentifier(body: unknown): Resolved {
  const parsed = identifierSchema.safeParse(body);
  if (!parsed.success) return { error: "invalid_input" };
  if (parsed.data.channel === "sms") {
    const phone = normalizeSignInPhone(parsed.data.phone);
    if (phone) return { channel: "sms", identifier: phone };
    // A real number outside North America is a format fact, not an existence
    // fact: the app answers it by offering email.
    return { error: toE164(parsed.data.phone) ? "phone_not_supported" : "invalid_phone" };
  }
  const email = normalizeEmail(parsed.data.email);
  return email ? { channel: "email", identifier: email } : { error: "invalid_email" };
}

customerAuthRouter.post("/start", customerAuthLimiter, async (req, res) => {
  const resolved = resolveIdentifier(req.body ?? {});
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  // Eligibility, caps, the budget and the send itself are the service's. The
  // send is fire-and-forget, so this ok leaves before any provider work.
  await requestSignInCode({ ...resolved, ip: callerIp(req), now: new Date() });
  res.json({ ok: true });
});

const verifySchema = z.object({ code: z.string().min(1).max(12) }).passthrough();

customerAuthRouter.post("/verify", customerAuthLimiter, async (req, res) => {
  const body = verifySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { code, ...rest } = body.data;
  const resolved = resolveIdentifier(rest);
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const now = new Date();
  const outcome = await verifySignInCode({ ...resolved, code: code.trim(), now });
  if (!outcome.verified) {
    res.json({ verified: false });
    return;
  }

  const account = await accountForProof({ ...resolved, now });
  const links = await syncCustomerLinks(account.id, now);

  // A first sign-in is asked what to call them. The name a shop already has
  // for them is offered as the default - it is their own name, from their own
  // record - but never copied onto the account without them confirming it.
  const profile = await runAsOwner(async (tx) => {
    const acct = await tx.customerAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { firstName: true },
    });
    const suggestion =
      acct.firstName === null && links.length > 0
        ? await tx.client.findFirst({
            where: { id: { in: links.map((l) => l.clientId) }, firstName: { not: null } },
            orderBy: [{ lastVisitAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
            select: { firstName: true },
          })
        : null;
    return { firstName: acct.firstName, suggestedFirstName: suggestion?.firstName ?? null };
  });

  res.json({
    verified: true,
    token: mintCustomerSession(account.id, account.tokenVersion),
    account: { ...profile, isNew: account.created },
  });
});

/**
 * "Just looking?" - App Review's way in, and anyone curious. A read-only
 * session on the seeded demo shop; 404 when the demo tenant isn't seeded.
 */
customerAuthRouter.post("/demo", customerAuthLimiter, async (_req, res) => {
  const account = await demoAccount();
  if (!account) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ token: mintCustomerSession(account.id, account.tokenVersion, { demo: true }) });
});
