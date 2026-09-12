import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { runAsOwner, runWithShop } from "@chairback/db";
import { customerApiLimiter } from "../middleware/rateLimit.js";
import { requireCustomer, requireCustomerAccounts } from "../middleware/requireCustomer.js";
import {
  buildHome,
  findEvent,
  loadPortal,
  manageUrl,
  rewardPrograms,
  splitHistory,
  storefrontUrl,
} from "../services/customerPortal.js";
import {
  claimProfile,
  rejectProfileForAccount,
  syncCustomerLinks,
} from "../services/customerIdentity.js";
import {
  identifierDigest,
  requestSignInCode,
  verifySignInCode,
} from "../services/customerSignIn.js";
import { consentView, optInClientInTx, optOutClientInTx } from "../services/clientConsent.js";
import { resolveIdentifier } from "./customerAuth.js";
import { logger } from "../logger.js";

/**
 * /api/me - the signed-in customer's own ChairBack.
 *
 * 🔴 THE ACCOUNT COMES FROM THE SESSION AND NOWHERE ELSE. No route here takes
 * an account id. The only ids a caller supplies are keys this API issued to
 * that same account (a link key, an appointment id), and every one is checked
 * against the account's OWN active links before it is used - anything else is
 * a 404 identical to "does not exist", so a guessed id learns nothing.
 *
 * Replies are built from explicit fields (services/customerPortal.ts); no
 * database row is ever spread into a response.
 */
export const customerMeRouter: Router = Router();
customerMeRouter.use(requireCustomerAccounts, customerApiLimiter, requireCustomer);

function accountId(req: Request): string {
  return req.customer!.accountId;
}

function notFound(res: Response): void {
  res.status(404).json({ error: "not_found" });
}

/** Credentials in a body are fine; cached ones are not. */
function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

// --- Home, history, details -----------------------------------------------------

customerMeRouter.get("/home", async (req, res) => {
  res.json(await buildHome(accountId(req)));
});

customerMeRouter.get("/appointments", async (req, res) => {
  const now = new Date();
  res.json(splitHistory(await loadPortal(accountId(req), now), now));
});

customerMeRouter.get("/appointments/:id", async (req, res) => {
  const event = findEvent(await loadPortal(accountId(req)), String(req.params.id));
  if (!event) return notFound(res);
  res.json({ appointment: event });
});

/** The shop's own manage page (reschedule / cancel) for one ChairBack booking. */
customerMeRouter.get("/appointments/:id/manage", async (req, res) => {
  const url = await manageUrl(accountId(req), String(req.params.id));
  if (!url) return notFound(res);
  noStore(res);
  res.json({ url });
});

// --- Shops ------------------------------------------------------------------------

/** The shop's existing storefront, as this customer's record sees it. */
customerMeRouter.get("/shops/:key/storefront", async (req, res) => {
  const url = await storefrontUrl(accountId(req), String(req.params.key));
  if (!url) return notFound(res);
  noStore(res);
  res.json({ url });
});

/**
 * "This isn't me": stop showing THIS profile, for good.
 *
 * One profile, not the whole shop. Where a phone is shared - a parent and a
 * child at the same barbershop - one of the records at that shop really is
 * theirs, and disowning the other must not take it away too.
 */
customerMeRouter.post("/shops/:key/not-me", async (req, res) => {
  const rejected = await rejectProfileForAccount(accountId(req), String(req.params.key));
  if (!rejected) return notFound(res);
  res.json({ ok: true });
});

/**
 * Connect a profile the contact alone could not: the customer produces the
 * shop's own link to it (/r/<token>, from their text or email). Accepts the
 * whole URL or the token.
 *
 * Every refusal that could confirm a record exists answers the same 404.
 */
const claimSchema = z.object({ link: z.string().min(8).max(500) }).strict();

function tokenFromLink(raw: string): string | null {
  const trimmed = raw.trim();
  const fromUrl = /\/r\/([A-Za-z0-9_-]{16,128})/.exec(trimmed);
  const token = fromUrl?.[1] ?? trimmed;
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

customerMeRouter.post("/profiles/claim", async (req, res) => {
  const parsed = claimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const token = tokenFromLink(parsed.data.link);
  if (!token) return notFound(res);
  const outcome = await claimProfile(accountId(req), token);
  if (!outcome.ok) {
    if (outcome.reason === "claimed_elsewhere") {
      res.status(409).json({ error: "claimed_elsewhere" });
      return;
    }
    if (outcome.reason === "too_many") {
      res.status(409).json({ error: "too_many" });
      return;
    }
    return notFound(res);
  }
  res.json({ ok: true });
});

// --- Rewards --------------------------------------------------------------------------

customerMeRouter.get("/rewards", async (req, res) => {
  res.json({ programs: await rewardPrograms(await loadPortal(accountId(req))) });
});

// --- Profile ----------------------------------------------------------------------------

async function profile(id: string) {
  const a = await runAsOwner((tx) =>
    tx.customerAccount.findUniqueOrThrow({
      where: { id },
      select: {
        firstName: true,
        lastName: true,
        phoneE164: true,
        emailNormalized: true,
        pushEnabled: true,
        isDemo: true,
      },
    }),
  );
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    phone: a.phoneE164,
    email: a.emailNormalized,
    pushEnabled: a.pushEnabled,
    isDemo: a.isDemo,
  };
}

customerMeRouter.get("/", async (req, res) => {
  res.json({ profile: await profile(accountId(req)) });
});

const nameField = z
  .string()
  .trim()
  .max(40)
  .transform((s) => (s.length === 0 ? null : s));

const profileSchema = z
  .object({ firstName: nameField.optional(), lastName: nameField.optional() })
  .strict();

customerMeRouter.patch("/", async (req, res) => {
  const parsed = profileSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const id = accountId(req);
  await runAsOwner((tx) =>
    tx.customerAccount.update({
      where: { id },
      data: {
        ...(parsed.data.firstName !== undefined ? { firstName: parsed.data.firstName } : {}),
        ...(parsed.data.lastName !== undefined ? { lastName: parsed.data.lastName } : {}),
      },
    }),
  );
  res.json({ profile: await profile(id) });
});

/**
 * Add or change the phone or email: prove it with a code first, exactly like
 * signing in. A contact already on another account is refused - its owner
 * signs in with it instead; two accounts never share a contact.
 */
customerMeRouter.post("/contact/start", async (req, res) => {
  const resolved = resolveIdentifier(req.body ?? {});
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  await requestSignInCode({ ...resolved, ip: req.ip ?? "unknown", now: new Date() });
  res.json({ ok: true });
});

const contactVerifySchema = z.object({ code: z.string().min(1).max(12) }).passthrough();

customerMeRouter.post("/contact/verify", async (req, res) => {
  const body = contactVerifySchema.safeParse(req.body ?? {});
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
  const id = accountId(req);
  const data =
    resolved.channel === "sms"
      ? { phoneE164: resolved.identifier, phoneVerifiedAt: now }
      : { emailNormalized: resolved.identifier, emailVerifiedAt: now };
  try {
    await runAsOwner((tx) => tx.customerAccount.update({ where: { id }, data }));
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ verified: true, error: "in_use" });
      return;
    }
    throw err;
  }
  // The new proof may match records the old one didn't (and the replaced one
  // may stop matching some): reconcile now rather than on the next read.
  await syncCustomerLinks(id, now);
  res.json({ verified: true, profile: await profile(id) });
});

// --- Notifications ------------------------------------------------------------------

/**
 * Texts are PER SHOP - consent is a shop's, never copied across shops - and a
 * switch speaks for every record this account holds at that shop. Push is the
 * account's own switch over and above the phone's permission.
 */
async function notificationView(id: string) {
  const [account, bundles] = await Promise.all([
    runAsOwner((tx) =>
      tx.customerAccount.findUniqueOrThrow({
        where: { id },
        select: { pushEnabled: true, phoneE164: true },
      }),
    ),
    loadPortal(id),
  ]);
  const texts = [];
  for (const b of bundles) {
    const primary = await runWithShop(b.shop.id, (tx) =>
      tx.client.findFirst({
        where: { id: b.primaryClientId, shopId: b.shop.id },
        select: { optedOut: true, smsConsentAt: true, phone: true },
      }),
    );
    if (!primary) continue;
    const view = consentView(primary);
    texts.push({
      key: b.ref.key,
      shopName: b.ref.name,
      on: view.state === "opted_in",
      // Turning texts on needs a number: the record's, or the account's own
      // verified one. With neither, the switch explains instead of failing.
      canTurnOn: view.hasPhone || account.phoneE164 !== null,
    });
  }
  return { push: { enabled: account.pushEnabled }, texts };
}

customerMeRouter.get("/notifications", async (req, res) => {
  res.json(await notificationView(accountId(req)));
});

const notificationsSchema = z
  .object({
    push: z.boolean().optional(),
    texts: z
      .array(z.object({ key: z.string().min(1).max(64), on: z.boolean() }).strict())
      .max(60)
      .optional(),
  })
  .strict();

customerMeRouter.patch("/notifications", async (req, res) => {
  const parsed = notificationsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const id = accountId(req);
  const { push, texts } = parsed.data;
  if (push !== undefined) {
    await runAsOwner((tx) => tx.customerAccount.update({ where: { id }, data: { pushEnabled: push } }));
  }
  if (texts && texts.length > 0) {
    const links = await syncCustomerLinks(id);
    const account = await runAsOwner((tx) =>
      tx.customerAccount.findUniqueOrThrow({ where: { id }, select: { phoneE164: true } }),
    );
    for (const change of texts) {
      // The key must be one of this account's own active links; its SHOP is
      // what the switch speaks for - every record the account holds there.
      const keyed = links.find((l) => l.id === change.key);
      if (!keyed) return notFound(res);
      const clientIds = links.filter((l) => l.shopId === keyed.shopId).map((l) => l.clientId);
      await runWithShop(keyed.shopId, async (tx) => {
        const clients = await tx.client.findMany({
          where: { shopId: keyed.shopId, id: { in: clientIds } },
          select: { id: true, phone: true, optedOut: true, optOutSource: true },
        });
        for (const c of clients) {
          if (change.on) await optInClientInTx(tx, c, account.phoneE164);
          else await optOutClientInTx(tx, c);
        }
      });
    }
  }
  res.json(await notificationView(id));
});

// --- Devices ----------------------------------------------------------------------------

const deviceSchema = z
  .object({
    expoPushToken: z.string().min(10).max(200).regex(/^Expo(nent)?PushToken\[[^\]]+\]$/),
    platform: z.enum(["ios", "android"]),
  })
  .strict();

/** Register this phone for push from every linked shop. Re-points a token that moved accounts. */
customerMeRouter.post("/devices", async (req, res) => {
  const parsed = deviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const id = accountId(req);
  await runAsOwner((tx) =>
    tx.customerDevice.upsert({
      where: { expoPushToken: parsed.data.expoPushToken },
      create: { accountId: id, ...parsed.data },
      update: { accountId: id, platform: parsed.data.platform, failureCount: 0, lastSeenAt: new Date() },
    }),
  );
  res.json({ ok: true });
});

/** Sign-out calls this first, so a signed-out phone stops hearing from anyone. */
customerMeRouter.post("/devices/remove", async (req, res) => {
  const parsed = z.object({ expoPushToken: z.string().min(10).max(200) }).strict().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const id = accountId(req);
  await runAsOwner((tx) =>
    tx.customerDevice.deleteMany({ where: { accountId: id, expoPushToken: parsed.data.expoPushToken } }),
  );
  res.json({ ok: true });
});

// --- Deletion -------------------------------------------------------------------------

/**
 * Delete the My ChairBack account (App Store 5.1.1(v)). Removes the account,
 * its links, its devices and its pending codes; every session it held dies
 * with it (requireCustomer finds no account). Each SHOP's record of this
 * customer stays with that shop - it predates the account and is the shop's
 * business record - and remains erasable per shop through the storefront's
 * own "Delete my data".
 */
customerMeRouter.delete("/", async (req, res) => {
  const id = accountId(req);
  await runAsOwner(async (tx) => {
    const acct = await tx.customerAccount.findUnique({
      where: { id },
      select: { phoneE164: true, emailNormalized: true },
    });
    if (!acct) return;
    const hashes = [
      acct.phoneE164 ? { channel: "sms", identifierHash: identifierDigest("sms", acct.phoneE164) } : null,
      acct.emailNormalized
        ? { channel: "email", identifierHash: identifierDigest("email", acct.emailNormalized) }
        : null,
    ].filter((h): h is { channel: string; identifierHash: string } => h !== null);
    if (hashes.length > 0) await tx.customerSignInCode.deleteMany({ where: { OR: hashes } });
    await tx.customerAccount.delete({ where: { id } });
  });
  logger.info({ accountId: id }, "customer account deleted by its owner");
  res.json({ ok: true });
});
