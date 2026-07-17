import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Per-shop number auto-provisioning: when a shop activates Premium AI, buy it
 * a local number, point the number's inbound webhook at the API, attach it to
 * the VERIFIED A2P campaign's messaging service (carriers treat unattached
 * numbers as unregistered and filter them), and save it on the shop. From then
 * on, inbound texts TO that number pin routing to the shop and its
 * receptionist replies send FROM it (see receptionist/inbound.ts).
 *
 * Money: each number is a real ~$1.15/mo Twilio purchase, so the whole module
 * is dark unless TWILIO_MESSAGING_SERVICE_SID is set - and it never throws
 * into the Stripe webhook path (a failed purchase logs for manual follow-up;
 * the shop just stays on the shared line, which keeps working).
 *
 * Scale: one A2P campaign carries at most TWILIO_CAMPAIGN_NUMBER_CAP numbers
 * (49 without number-pooling approval). TWILIO_MESSAGING_SERVICE_SID is an
 * ordered comma-separated list - one messaging service per registered
 * campaign - and each purchase attaches to the first service with a free
 * slot. Growing past capacity is therefore an env edit, not a code change:
 * register the next campaign in Twilio, append its MG sid. A loud log fires
 * while free slots remain (campaign vetting takes days, so the warning must
 * lead the wall).
 */

export interface ProvisionedNumber {
  phoneNumber: string; // E.164
  sid: string; // PN... incoming phone number sid
}

export interface NumberProvisioner {
  /** Buy + configure one local number, or null on failure (already logged). */
  provision(opts: { friendlyName: string }): Promise<ProvisionedNumber | null>;
  /** Release a purchased number (a concurrent provision won the claim). */
  release(sid: string): Promise<void>;
}

/** Warn while this many free slots (or fewer) remain across ALL campaigns. */
const LOW_CAPACITY_WARN = 5;

/** TWILIO_MESSAGING_SERVICE_SID parsed as an ordered list of MG sids. */
function serviceSids(): string[] {
  return (apiEnv().TWILIO_MESSAGING_SERVICE_SID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pick which campaign the next number attaches to: the first with a free
 * slot. Pure so the spill-over/full/runway arithmetic is unit-testable.
 * `remainingAfter` = free slots across every campaign once this attach lands.
 */
export function planAttach(
  counts: number[],
  cap: number,
): { index: number | null; remainingAfter: number } {
  const index = counts.findIndex((c) => c < cap);
  const free = counts.reduce((sum, c) => sum + Math.max(0, cap - c), 0);
  return index === -1
    ? { index: null, remainingAfter: 0 }
    : { index, remainingAfter: free - 1 };
}

class TwilioNumberProvisioner implements NumberProvisioner {
  async release(sid: string): Promise<void> {
    const env = apiEnv();
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    await client.incomingPhoneNumbers(sid).remove();
  }

  async provision(opts: { friendlyName: string }): Promise<ProvisionedNumber | null> {
    const env = apiEnv();
    const sids = serviceSids();
    if (sids.length === 0) return null;
    const cap = env.TWILIO_CAMPAIGN_NUMBER_CAP;
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    const webhookUrl = `${env.API_BASE_URL}/webhooks/twilio/inbound`;

    // Count each campaign's numbers and pick the first with room - BEFORE
    // buying, so a fully-saturated fleet costs nothing but this read.
    const counts: number[] = [];
    for (const sid of sids) {
      counts.push(
        (await client.messaging.v1.services(sid).phoneNumbers.list({ limit: cap })).length,
      );
    }
    const { index, remainingAfter } = planAttach(counts, cap);
    if (index === null) {
      logger.error(
        { counts, cap },
        "number provisioning: EVERY campaign is full - register another A2P " +
          "campaign and append its messaging service SID to TWILIO_MESSAGING_SERVICE_SID",
      );
      return null;
    }
    if (remainingAfter <= LOW_CAPACITY_WARN) {
      logger.error(
        { counts, cap, remainingAfter },
        "number provisioning: capacity runway low - register the NEXT A2P " +
          "campaign now (vetting takes days) and append its messaging service " +
          "SID to TWILIO_MESSAGING_SERVICE_SID",
      );
    }

    // Preferred area code first; nationwide local inventory as the fallback.
    const searches: { areaCode?: number }[] = env.TWILIO_NUMBER_AREA_CODE
      ? [{ areaCode: Number(env.TWILIO_NUMBER_AREA_CODE) }, {}]
      : [{}];
    let candidate: string | null = null;
    for (const search of searches) {
      const available = await client
        .availablePhoneNumbers("US")
        .local.list({ ...search, smsEnabled: true, limit: 1 });
      if (available[0]?.phoneNumber) {
        candidate = available[0].phoneNumber;
        break;
      }
    }
    if (!candidate) {
      logger.error("number provisioning: no local inventory available");
      return null;
    }

    // THE PURCHASE (~$1.15/mo starts here). The webhook is set in the same
    // call so there is no window where the number exists but inbound is lost.
    const bought = await client.incomingPhoneNumbers.create({
      phoneNumber: candidate,
      friendlyName: opts.friendlyName,
      smsUrl: webhookUrl,
      smsMethod: "POST",
    });

    // Attach to a campaign's messaging service. An unattached number sends
    // unregistered (carrier-filtered), so on total failure release it rather
    // than half-provision. The counts above can race a concurrent purchase,
    // so if the chosen campaign rejects the attach, spill to the later ones
    // before giving up.
    let attached = false;
    for (const sid of sids.slice(index)) {
      try {
        await client.messaging.v1.services(sid).phoneNumbers.create({
          phoneNumberSid: bought.sid,
        });
        attached = true;
        break;
      } catch (err) {
        logger.error(
          { err, phoneNumber: bought.phoneNumber, serviceSid: sid },
          "number provisioning: campaign attach failed; trying the next campaign",
        );
      }
    }
    if (!attached) {
      logger.error(
        { phoneNumber: bought.phoneNumber },
        "number provisioning: no campaign accepted the number; releasing it",
      );
      await client
        .incomingPhoneNumbers(bought.sid)
        .remove()
        .catch(() => {});
      return null;
    }

    return { phoneNumber: bought.phoneNumber, sid: bought.sid };
  }
}

let testProvisioner: NumberProvisioner | undefined;

/** Test seam: inject a fake provisioner (no Twilio, no purchases). */
export function __setNumberProvisionerForTests(p: NumberProvisioner | undefined): void {
  testProvisioner = p;
}

function getProvisioner(): NumberProvisioner {
  return testProvisioner ?? new TwilioNumberProvisioner();
}

/**
 * Idempotently give a Premium AI shop its own number. Safe to fire from every
 * Stripe path that lands plan="pro_ai" (checkout, subscription webhook, the
 * in-place upgrade): it no-ops when provisioning is unconfigured, the shop
 * already has a number, or the plan isn't Premium AI. Never throws.
 */
export async function ensureShopNumber(shopId: string): Promise<void> {
  try {
    if (!apiEnv().TWILIO_MESSAGING_SERVICE_SID && !testProvisioner) return;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { id: true, name: true, plan: true, twilioNumber: true },
    });
    if (!shop || shop.twilioNumber || shop.plan !== "pro_ai") return;

    const bought = await getProvisioner().provision({
      friendlyName: `ChairBack - ${shop.name}`,
    });
    if (!bought) {
      logger.error({ shopId }, "number provisioning failed; shop stays on the shared line");
      return;
    }
    // Claim the slot only if it is still empty: checkout and
    // subscription.updated fire back-to-back for the same shop, and two
    // in-flight provisions would otherwise both buy - the overwritten number
    // would keep billing as an invisible orphan. The loser releases.
    const claimed = await prisma.shop.updateMany({
      where: { id: shopId, twilioNumber: null },
      data: { twilioNumber: bought.phoneNumber },
    });
    if (claimed.count === 0) {
      logger.warn(
        { shopId, phoneNumber: bought.phoneNumber },
        "concurrent provision already claimed this shop; releasing the duplicate number",
      );
      await getProvisioner()
        .release(bought.sid)
        .catch((err) =>
          logger.error(
            { err, phoneNumber: bought.phoneNumber, sid: bought.sid },
            "duplicate number release FAILED - release it manually in the Twilio console",
          ),
        );
      return;
    }
    logger.info(
      { shopId, phoneNumber: bought.phoneNumber },
      "shop provisioned with its own number",
    );
  } catch (err) {
    logger.error({ err, shopId }, "ensureShopNumber failed");
  }
}
