import { createHash, randomBytes } from "node:crypto";
import { prisma, runAsOwner, runWithShop } from "@chairback/db";
import { SAVED_CARD_CONSENT_VERSION, SERVICE_CHARGE_CONSENT_VERSION } from "@chairback/config";
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  RESEND_COOLDOWN_MS,
  SEND_WINDOW_MS,
  codeShapeOk,
  digestsMatch,
  hashOtp,
  mintCode,
} from "../engines/otpPolicy.js";
import { buildSavedCardCodeBody } from "../messaging/templates.js";
import { billableSegments, positiveCapFromEnv, takeWindowedBudget } from "../services/recoverySmsBudget.js";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";
import { stripeErrorFacts } from "./stripeErrors.js";

/**
 * A CLIENT'S SAVED CARD - kept by one shop for the client's future
 * appointments, at the client's own request.
 *
 * A barber, 2026-09-30: "save a universal card so appointments go straight
 * through after they select time... they can choose from saved cards", and the
 * owner: "in the client database they can also have their card on file there
 * so they don't have to keep adding it".
 *
 * HOW IT FITS WHAT EXISTS. A card on file has always belonged to ONE booking
 * (billing/cardOnFile.ts): its own Stripe Customer, released after the visit.
 * A saved card keeps that booking's Customer and payment method alive past the
 * visit, on a SavedCard row, and every later appointment that uses it gets an
 * ordinary CardOnFile row pointing here. So the no-show fee, the late-cancel
 * fee and the service checkout (with its own per-booking consent) all charge
 * it through the paths they already use - `paymentMethodFor` resolves the
 * method through the SavedCard.
 *
 * 🔴 THE ROW NEVER OWNS THE METHOD. A CardOnFile row linked to a SavedCard
 * carries `stripePaymentMethodId = NULL`, exactly like a standing
 * appointment's occurrence rows, for the same reason: the release path detaches
 * whatever method it finds on a row, and a rolled-back API must never detach a
 * card the client asked the shop to keep. Only the SavedCard holds it, and only
 * `detachSavedCardIfUnused` lets it go - once the client has removed it AND no
 * appointment still needs it.
 *
 * 🔴 POSSESSION, NEVER A PHONE NUMBER. Anyone can type someone else's number,
 * so the booking page can use a saved card only with a device token (issued to
 * the browser it was saved on, or to one that proved itself with a text code
 * to the client's phone). Only token HASHES are stored.
 */

/** How long after saving the card its first device may still collect a token. */
export const FIRST_DEVICE_WINDOW_MS = 60 * 60 * 1000;

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function newSavedCardId(): string {
  return `scard_${randomBytes(12).toString("hex")}`;
}

function newCardOnFileId(): string {
  return `cof_${randomBytes(12).toString("hex")}`;
}

export interface SavedCardView {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  savedAt: string;
}

function view(c: {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  createdAt: Date;
}): SavedCardView {
  return {
    id: c.id,
    brand: c.brand,
    last4: c.last4,
    expMonth: c.expMonth,
    expYear: c.expYear,
    savedAt: c.createdAt.toISOString(),
  };
}

/** The client's live saved card at this shop, or null. */
export async function liveSavedCardFor(shopId: string, clientId: string): Promise<SavedCardView | null> {
  const card = await runWithShop(shopId, (tx) =>
    tx.savedCard.findFirst({
      where: { shopId, clientId, removedAt: null, detachedAt: null },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, createdAt: true },
    }),
  );
  return card ? view(card) : null;
}

/**
 * The live saved card ONE appointment's manage link may show and take off: the
 * card this booking saved, or the one it was booked with (its card row points
 * at it - which a shop's own booking for the client also does, see
 * attachClientSavedCard). Null for anything else.
 *
 * 🔴 NOT "the client's card". The booking page finds its client by the TYPED
 * phone, so anyone who books with a client's number lands on the client's
 * record and is sent a manage link of their own. The record proves nothing
 * about who holds that link; the booking it belongs to does. Possession again,
 * never a phone number.
 */
export async function savedCardForAppointment(
  shopId: string,
  appointmentId: string,
): Promise<SavedCardView | null> {
  const card = await runWithShop(shopId, (tx) =>
    tx.savedCard.findFirst({
      where: {
        shopId,
        removedAt: null,
        detachedAt: null,
        OR: [{ sourceAppointmentId: appointmentId }, { cardsOnFile: { some: { appointmentId } } }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, createdAt: true },
    }),
  );
  return card ? view(card) : null;
}

/**
 * The booking's card was saved and the client ticked "save it for my future
 * appointments": keep it. Called once the hold has become a booking.
 *
 * Replaces any card the client had saved here before (one live card per client
 * per shop), links this booking's row to the new SavedCard and hands the
 * payment method over to it - the row's own copy is cleared, so this visit
 * finishing can never detach it.
 */
export async function saveCardFromBooking(params: {
  shopId: string;
  appointmentId: string;
}): Promise<string | null> {
  const row = await runWithShop(params.shopId, (tx) =>
    tx.cardOnFile.findUnique({
      where: { appointmentId: params.appointmentId },
      select: {
        id: true,
        status: true,
        stripeCustomerId: true,
        stripePaymentMethodId: true,
        brand: true,
        last4: true,
        savedCardId: true,
        saveCardConsentVersion: true,
        saveCardConsentAt: true,
        appointment: { select: { clientId: true, status: true } },
      },
    }),
  );
  if (!row || row.savedCardId) return row?.savedCardId ?? null;
  if (!row.saveCardConsentVersion || !row.saveCardConsentAt) return null;
  if (row.status !== "saved" || !row.stripePaymentMethodId) return null;
  const clientId = row.appointment.clientId;
  if (!clientId || row.appointment.status !== "BOOKED") return null;

  let expMonth: number | null = null;
  let expYear: number | null = null;
  try {
    const pm = await stripeClient().paymentMethods.retrieve(row.stripePaymentMethodId);
    expMonth = pm.card?.exp_month ?? null;
    expYear = pm.card?.exp_year ?? null;
  } catch (err) {
    logger.warn({ appointmentId: params.appointmentId, ...stripeErrorFacts(err) }, "saved card: could not read expiry");
  }

  const savedCardId = newSavedCardId();
  const replaced = await runWithShop(params.shopId, async (tx) => {
    // The one live card per client: the old one steps aside first, or the
    // partial unique refuses the new one.
    const old = await tx.savedCard.findMany({
      where: { shopId: params.shopId, clientId, removedAt: null },
      select: { id: true },
    });
    if (old.length > 0) {
      await tx.savedCard.updateMany({
        where: { id: { in: old.map((o) => o.id) } },
        data: { removedAt: new Date() },
      });
      await tx.savedCardDevice.updateMany({
        where: { savedCardId: { in: old.map((o) => o.id) }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await tx.savedCard.create({
      data: {
        id: savedCardId,
        shopId: params.shopId,
        clientId,
        stripeCustomerId: row.stripeCustomerId,
        stripePaymentMethodId: row.stripePaymentMethodId!,
        brand: row.brand,
        last4: row.last4,
        expMonth,
        expYear,
        consentVersion: row.saveCardConsentVersion!,
        consentAt: row.saveCardConsentAt!,
        sourceAppointmentId: params.appointmentId,
      },
    });
    // The method now belongs to the SavedCard, not to this one visit.
    await tx.cardOnFile.update({
      where: { id: row.id },
      data: { savedCardId, stripePaymentMethodId: null },
    });
    return old.map((o) => o.id);
  });
  for (const oldId of replaced) await detachSavedCardIfUnused(params.shopId, oldId);
  logger.info({ shopId: params.shopId, savedCardId, replaced: replaced.length }, "saved card: kept for the client's future appointments");
  return savedCardId;
}

/**
 * The browser the card was just saved on gets a token that lets it use the card
 * next time. Only its FIRST device, and only soon after saving: the manage link
 * that authorises this call also sits in an email, and must not become a way to
 * mint cards-on-demand on other phones later - those use a text code.
 */
export async function issueFirstDeviceToken(params: {
  shopId: string;
  appointmentId: string;
  now?: Date;
}): Promise<{ token: string; card: SavedCardView } | null> {
  const now = params.now ?? new Date();
  const row = await runWithShop(params.shopId, (tx) =>
    tx.cardOnFile.findUnique({
      where: { appointmentId: params.appointmentId },
      select: {
        savedCard: {
          select: {
            id: true,
            sourceAppointmentId: true,
            removedAt: true,
            detachedAt: true,
            brand: true,
            last4: true,
            expMonth: true,
            expYear: true,
            createdAt: true,
            _count: { select: { devices: true } },
          },
        },
      },
    }),
  );
  const card = row?.savedCard;
  if (!card || card.removedAt || card.detachedAt) return null;
  if (card.sourceAppointmentId !== params.appointmentId) return null;
  if (card._count.devices > 0) return null;
  if (now.getTime() - card.createdAt.getTime() > FIRST_DEVICE_WINDOW_MS) return null;
  const token = newToken();
  await runWithShop(params.shopId, (tx) =>
    tx.savedCardDevice.create({ data: { shopId: params.shopId, savedCardId: card.id, tokenHash: hashSecret(token) } }),
  );
  return { token, card: view(card) };
}

/**
 * The saved card a device token unlocks at this shop - live, not revoked - with
 * the client it belongs to. Null for anything else, never a reason: a probe
 * learns nothing about why a token failed.
 */
export async function savedCardForToken(
  shopId: string,
  token: string,
): Promise<{ card: SavedCardView; clientId: string; deviceId: string; stripeCustomerId: string } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const device = await runWithShop(shopId, (tx) =>
    tx.savedCardDevice.findUnique({
      where: { tokenHash: hashSecret(token) },
      select: {
        id: true,
        shopId: true,
        revokedAt: true,
        savedCard: {
          select: {
            id: true,
            shopId: true,
            clientId: true,
            stripeCustomerId: true,
            removedAt: true,
            detachedAt: true,
            brand: true,
            last4: true,
            expMonth: true,
            expYear: true,
            createdAt: true,
          },
        },
      },
    }),
  );
  if (!device || device.revokedAt || device.shopId !== shopId) return null;
  const c = device.savedCard;
  if (c.shopId !== shopId || c.removedAt || c.detachedAt) return null;
  return { card: view(c), clientId: c.clientId, deviceId: device.id, stripeCustomerId: c.stripeCustomerId };
}

/**
 * An appointment booked with the client's saved card gets its card row now: a
 * card on file like any other, already `saved`, pointing at the SavedCard.
 * `serviceChargeConsent` is THIS booking's own tick - the saved card never
 * carries permission to charge a service from one booking to the next.
 */
export async function attachSavedCardToAppointment(params: {
  shopId: string;
  appointmentId: string;
  savedCardId: string;
  serviceChargeConsent?: boolean;
  deviceId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const card = await runWithShop(params.shopId, (tx) =>
    tx.savedCard.findFirst({
      where: { id: params.savedCardId, shopId: params.shopId, removedAt: null, detachedAt: null },
      select: { id: true, stripeCustomerId: true, brand: true, last4: true },
    }),
  );
  if (!card) return false;
  try {
    await runWithShop(params.shopId, async (tx) => {
      await tx.cardOnFile.create({
        data: {
          id: newCardOnFileId(),
          shopId: params.shopId,
          appointmentId: params.appointmentId,
          stripeCustomerId: card.stripeCustomerId,
          // No SetupIntent was needed; a per-row marker keeps the unique index.
          stripeSetupIntentId: `saved:${card.id}:${params.appointmentId}`,
          stripePaymentMethodId: null,
          brand: card.brand,
          last4: card.last4,
          status: "saved",
          savedAt: now,
          savedCardId: card.id,
          ...(params.serviceChargeConsent
            ? {
                serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
                serviceChargeConsentAt: now,
                serviceChargeConsentScope: "single",
              }
            : {}),
        },
      });
      if (params.deviceId) {
        await tx.savedCardDevice.update({ where: { id: params.deviceId }, data: { lastUsedAt: now } });
      }
    });
    return true;
  } catch (err) {
    // Already has a card row (a retry) - not an error for the booking.
    logger.warn({ appointmentId: params.appointmentId, err }, "saved card: could not attach to the appointment");
    return false;
  }
}

/**
 * A booking the SHOP made (dashboard, phone, walk-up) for a client who saved a
 * card here: the card goes on it too - they asked the shop to keep it for their
 * future appointments, and this is one of them. Only in card-on-file mode,
 * where a card on the appointment is how the shop runs. No service-charge
 * permission rides along: that is only ever the client's own tick.
 */
export async function attachClientSavedCard(params: {
  shopId: string;
  appointmentId: string;
  clientId: string | null;
}): Promise<boolean> {
  if (!params.clientId) return false;
  // Shop carries no RLS policy; read as the connection owner.
  const shop = await prisma.shop.findUnique({ where: { id: params.shopId }, select: { paymentsMode: true } });
  if (shop?.paymentsMode !== "card_on_file") return false;
  const card = await liveSavedCardFor(params.shopId, params.clientId);
  if (!card) return false;
  return attachSavedCardToAppointment({
    shopId: params.shopId,
    appointmentId: params.appointmentId,
    savedCardId: card.id,
  });
}

/**
 * The client takes the card off the shop's file. It is never offered again;
 * appointments already booked with it keep their protection until they are
 * done, and the method is detached when the last of them lets go.
 *
 * ONE card, named by id - the one the caller proved a right to (the manage
 * page: savedCardForAppointment). Never "every card this client has": the
 * client record is reached by a typed phone number.
 */
export async function removeSavedCard(params: {
  shopId: string;
  savedCardId: string;
  now?: Date;
}): Promise<{ removed: number }> {
  const now = params.now ?? new Date();
  const ids = await runWithShop(params.shopId, async (tx) => {
    const live = await tx.savedCard.findMany({
      where: { id: params.savedCardId, shopId: params.shopId, removedAt: null },
      select: { id: true },
    });
    if (live.length === 0) return [];
    await tx.savedCard.updateMany({ where: { id: { in: live.map((c) => c.id) } }, data: { removedAt: now } });
    await tx.savedCardDevice.updateMany({
      where: { savedCardId: { in: live.map((c) => c.id) }, revokedAt: null },
      data: { revokedAt: now },
    });
    return live.map((c) => c.id);
  });
  for (const id of ids) await detachSavedCardIfUnused(params.shopId, id);
  if (ids.length > 0) logger.info({ shopId: params.shopId, removed: ids.length }, "saved card: removed by the client");
  return { removed: ids.length };
}

/**
 * Detach a REMOVED saved card's payment method once no appointment still needs
 * it (pending, saved or mid-charge). Called on removal, on replacement, and
 * from the release path whenever a linked appointment lets go. Idempotent.
 */
export async function detachSavedCardIfUnused(shopId: string, savedCardId: string): Promise<boolean> {
  const card = await runWithShop(shopId, (tx) =>
    tx.savedCard.findFirst({
      where: { id: savedCardId, shopId },
      select: { id: true, removedAt: true, detachedAt: true, stripePaymentMethodId: true },
    }),
  );
  if (!card || !card.removedAt || card.detachedAt) return false;
  const stillInUse = await runWithShop(shopId, (tx) =>
    tx.cardOnFile.count({
      where: { savedCardId, status: { in: ["pending", "saved", "charging"] } },
    }),
  );
  if (stillInUse > 0) return false;
  const claimed = await runWithShop(shopId, (tx) =>
    tx.savedCard.updateMany({ where: { id: savedCardId, detachedAt: null }, data: { detachedAt: new Date() } }),
  );
  if (claimed.count === 0) return false;
  try {
    await stripeClient().paymentMethods.detach(card.stripePaymentMethodId);
  } catch (err) {
    logger.warn({ savedCardId, ...stripeErrorFacts(err) }, "saved card: detach failed (already detached?)");
  }
  return true;
}

/**
 * Does the person on the booking form look like the saved card's client? Their
 * phone (last ten digits) or email must match the client record. The token is
 * the proof; this only stops a remembered device booking someone ELSE on it.
 */
export async function formMatchesSavedCardClient(
  shopId: string,
  clientId: string,
  form: { phone: string | null; email: string | null },
): Promise<boolean> {
  const client = await runWithShop(shopId, (tx) =>
    tx.client.findFirst({ where: { id: clientId, shopId }, select: { phone: true, email: true } }),
  );
  if (!client) return false;
  const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "").slice(-10);
  if (form.phone && client.phone && digits(form.phone).length >= 7 && digits(form.phone) === digits(client.phone)) {
    return true;
  }
  const email = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  return Boolean(form.email && client.email && email(form.email) === email(client.email));
}

// ---------------------------------------------------------------------------
// A NEW DEVICE: a one-time text code to the client's phone.
// ---------------------------------------------------------------------------

/**
 * The platform ceiling on these texts, in billable segments: an hourly and a
 * daily window on their OWN ledger (services/recoverySmsBudget.ts), so a flood
 * of them can never starve sign-in codes, or the other way round. They go
 * while texting is off - they follow the sign-in switch, see
 * signInTextsEnabled() - so this is what bounds what they cost. Read at call
 * time; anything missing or not a positive number falls back to the default.
 */
export const SAVED_CARD_SMS_HOURLY_CAP_DEFAULT = 50;
export const SAVED_CARD_SMS_DAILY_CAP_DEFAULT = 200;

/**
 * The live saved card of the client at this shop with this phone, if any.
 * Internal: callers must never tell the requester whether one was found.
 */
async function savedCardByPhone(shopId: string, phoneE164: string) {
  return runWithShop(shopId, (tx) =>
    tx.savedCard.findFirst({
      where: { shopId, removedAt: null, detachedAt: null, client: { phone: phoneE164 } },
      select: { id: true, clientId: true, client: { select: { phone: true } } },
    }),
  );
}

/**
 * Start a code: returns the text to send and the phone to send it to, or null
 * when there is nothing to send (no saved card for that phone, a send within
 * the last minute, the hourly cap - engines/otpPolicy.ts, the rules every
 * code in the product follows - or the platform ceiling above). The ROUTE
 * answers the same either way.
 */
export async function createSavedCardCode(params: {
  shopId: string;
  shopName: string;
  phoneE164: string;
  now?: Date;
}): Promise<{ code: string; body: string; phone: string; clientId: string } | null> {
  const now = params.now ?? new Date();
  const card = await savedCardByPhone(params.shopId, params.phoneE164);
  if (!card?.client.phone) return null;
  const recent = await runWithShop(params.shopId, (tx) =>
    tx.savedCardCode.findMany({
      where: { savedCardId: card.id, createdAt: { gt: new Date(now.getTime() - SEND_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  );
  if (recent.length >= MAX_SENDS_PER_WINDOW) return null;
  if (recent[0] && now.getTime() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) return null;
  const code = mintCode();
  const body = buildSavedCardCodeBody({ shopName: params.shopName, code });
  // 🔴 THE PLATFORM CEILING, the last gate before spend: reserved before the
  // code exists, so a refusal leaves no code and no cooldown behind, and never
  // given back - an ambiguous provider outcome may still have cost money. The
  // owner connection: rate_limit_counter has no tenant policy.
  const funded = await runAsOwner((tx) =>
    takeWindowedBudget(tx, now, billableSegments(body), {
      keyPrefix: "savedCardSms:budget",
      hourlyCap: positiveCapFromEnv("SAVED_CARD_SMS_HOURLY_CAP", SAVED_CARD_SMS_HOURLY_CAP_DEFAULT),
      dailyCap: positiveCapFromEnv("SAVED_CARD_SMS_DAILY_CAP", SAVED_CARD_SMS_DAILY_CAP_DEFAULT),
      label: { words: "saved card code SMS", code: "saved_card_sms_budget" },
    }),
  );
  if (!funded) return null;
  await runWithShop(params.shopId, (tx) =>
    tx.savedCardCode.create({
      data: {
        shopId: params.shopId,
        savedCardId: card.id,
        codeHash: hashOtp(card.id, card.client.phone!, "saved_card", code),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    }),
  );
  return { code, body, phone: card.client.phone, clientId: card.clientId };
}

/**
 * Check a code; on success the device gets its own token. Wrong, expired, used
 * or over-tried codes all answer null alike.
 */
export async function verifySavedCardCode(params: {
  shopId: string;
  phoneE164: string;
  code: string;
  now?: Date;
}): Promise<{ token: string; card: SavedCardView } | null> {
  const now = params.now ?? new Date();
  if (!codeShapeOk(params.code)) return null;
  const card = await savedCardByPhone(params.shopId, params.phoneE164);
  if (!card?.client.phone) return null;
  const latest = await runWithShop(params.shopId, (tx) =>
    tx.savedCardCode.findFirst({
      where: { savedCardId: card.id, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, codeHash: true, attempts: true },
    }),
  );
  if (!latest || latest.attempts >= MAX_ATTEMPTS) return null;
  // Count the attempt BEFORE comparing, so a flood of guesses is capped even
  // if the comparison throws.
  await runWithShop(params.shopId, (tx) =>
    tx.savedCardCode.update({ where: { id: latest.id }, data: { attempts: { increment: 1 } } }),
  );
  if (!digestsMatch(latest.codeHash, hashOtp(card.id, card.client.phone, "saved_card", params.code))) return null;
  const consumed = await runWithShop(params.shopId, (tx) =>
    tx.savedCardCode.updateMany({ where: { id: latest.id, consumedAt: null }, data: { consumedAt: now } }),
  );
  if (consumed.count === 0) return null;
  const token = newToken();
  const full = await runWithShop(params.shopId, async (tx) => {
    await tx.savedCardDevice.create({
      data: { shopId: params.shopId, savedCardId: card.id, tokenHash: hashSecret(token) },
    });
    return tx.savedCard.findUniqueOrThrow({
      where: { id: card.id },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, createdAt: true },
    });
  });
  return { token, card: view(full) };
}

/** The save-for-later consent a booking may record: the current wording only. */
export function saveCardConsentForBooking(accepted: boolean | undefined, now: Date) {
  return accepted ? { saveCardConsentVersion: SAVED_CARD_CONSENT_VERSION, saveCardConsentAt: now } : {};
}

