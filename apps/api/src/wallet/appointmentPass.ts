import { createHmac, timingSafeEqual } from "node:crypto";
import { PKPass } from "passkit-generator";
import { apiEnv } from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import {
  decodeWalletCerts,
  hexToRgb,
  loadArt,
  pokeApnsRegistrations,
  type WalletCerts,
  type WalletPokeResult,
} from "./pass.js";

const env = apiEnv();

/**
 * Apple Wallet APPOINTMENT pass - an eventTicket for one booking, offered from
 * the confirmation email beside (never instead of) Add to Calendar.
 *
 * 🔴 A SEPARATE Pass Type ID from the punch card. Apple binds each signing
 * certificate to exactly one type id, and the two passes genuinely are
 * different things: the punch card is a long-lived storeCard that follows the
 * CLIENT, this is a dated eventTicket that follows one APPOINTMENT. Sharing
 * the id would also share the serial namespace and the APNs topic, and a
 * rewards poke would make every appointment pass re-fetch for nothing.
 *
 * Same machinery otherwise, imported from wallet/pass.ts rather than copied:
 * cert decode, brand art, and the APNs re-fetch poke.
 *
 * DARK until the WALLET_APPT_* env vars are set (plus the shared team id +
 * WWDR): the email hides its Add-to-Wallet button and every route 404s -
 * nothing about this pass type exists in production until the certificate
 * ceremony in WALLET-SETUP.md is done and the vars are deployed.
 */

export function appointmentWalletEnabled(): boolean {
  return Boolean(
    env.WALLET_APPT_PASS_TYPE_ID &&
      env.WALLET_APPT_PASS_CERT_BASE64 &&
      env.WALLET_APPT_PASS_KEY_BASE64 &&
      env.WALLET_TEAM_ID &&
      env.WALLET_WWDR_CERT_BASE64,
  );
}

/**
 * The pass's authenticationToken. Stateless HMAC like the punch card's, but
 * DOMAIN-SEPARATED ("wallet-appt-pass:") so a rewards pass token can never
 * authenticate an appointment pass even if the two id strings ever collided.
 */
export function apptPassAuthToken(appointmentId: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`wallet-appt-pass:${appointmentId}`)
    .digest("hex");
}

/** Constant-time check of the ApplePass authorization header for one pass. */
export function verifyApptPassAuth(
  header: string | undefined,
  appointmentId: string,
): boolean {
  if (!header?.startsWith("ApplePass ")) return false;
  const presented = Buffer.from(header.slice("ApplePass ".length));
  const expected = Buffer.from(apptPassAuthToken(appointmentId));
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// Signing material, decoded once. Lazy so boot never depends on wallet config.
let certs: WalletCerts | null = null;
function loadApptCerts(): WalletCerts {
  if (!certs) {
    certs = decodeWalletCerts({
      certBase64: env.WALLET_APPT_PASS_CERT_BASE64!,
      keyBase64: env.WALLET_APPT_PASS_KEY_BASE64!,
      ...(env.WALLET_APPT_PASS_KEY_PASSPHRASE
        ? { keyPassphrase: env.WALLET_APPT_PASS_KEY_PASSPHRASE }
        : {}),
    });
  }
  return certs;
}

/** Statuses that render a LIVE pass; anything else is served voided. */
const LIVE_STATUSES = new Set(["BOOKED"]);

/**
 * Short date/time labels in the SHOP's timezone - what's printed on the pass
 * face. The pass also carries relevantDate, which iOS uses for the lock-screen
 * surfacing near the appointment.
 */
function faceLabels(at: Date, timezone: string): { date: string; time: string } {
  try {
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(at);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
    return { date, time };
  } catch {
    return { date: at.toUTCString().slice(0, 11), time: at.toUTCString().slice(17, 22) };
  }
}

/**
 * Build + sign the CURRENT pass for one appointment. Returns null when the
 * appointment is gone. A canceled/completed appointment returns a VOIDED pass
 * - Wallet greys it out - because the devices that already added it re-fetch
 * through here after a poke, and "this is no longer valid" must be sayable.
 * Whether a FRESH download is allowed at all is the route's decision, not
 * this builder's.
 */
export async function buildPassForAppointment(
  appointmentId: string,
): Promise<Buffer | null> {
  const appt = await runAsOwner((tx) =>
    tx.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        endsAt: true,
        firstName: true,
        manageToken: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
        shop: {
          select: {
            name: true,
            timezone: true,
            accentColor: true,
            addressStreet: true,
            addressCity: true,
            addressRegion: true,
          },
        },
      },
    }),
  );
  if (!appt) return null;

  const manageUrl = `${env.APP_BASE_URL}/book/manage/${appt.manageToken}`;
  const { date, time } = faceLabels(appt.startsAt, appt.shop.timezone);
  const address = [appt.shop.addressStreet, appt.shop.addressCity, appt.shop.addressRegion]
    .map((l) => l?.trim())
    .filter(Boolean)
    .join(", ");
  const live = LIVE_STATUSES.has(appt.status);

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env.WALLET_APPT_PASS_TYPE_ID!,
    teamIdentifier: env.WALLET_TEAM_ID!,
    organizationName: appt.shop.name,
    description: `${appt.shop.name} appointment`,
    serialNumber: appt.id,
    webServiceURL: `${env.API_BASE_URL}/api/wallet`,
    authenticationToken: apptPassAuthToken(appt.id),
    sharingProhibited: true,
    // iOS surfaces the pass on the lock screen around this instant.
    relevantDate: appt.startsAt.toISOString(),
    // Wallet's own expiry/cleanup hint; the pass is meaningless a day after.
    expirationDate: new Date(appt.endsAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...(live ? {} : { voided: true }),
    logoText: appt.shop.name,
    backgroundColor: "rgb(10,10,11)",
    foregroundColor: "rgb(245,245,244)",
    labelColor: hexToRgb(appt.shop.accentColor, "rgb(212,175,55)"),
    eventTicket: {
      primaryFields: [
        {
          key: "when",
          label: live ? date.toUpperCase() : "CANCELED",
          value: time,
          // The lock-screen line Wallet shows when an update lands (reschedule).
          changeMessage: "Your appointment changed: now %@",
        },
      ],
      secondaryFields: [
        { key: "service", label: "SERVICE", value: appt.service?.name ?? "Appointment" },
        ...(appt.staff?.name
          ? [{ key: "with", label: "WITH", value: appt.staff.name }]
          : []),
      ],
      auxiliaryFields: [
        ...(appt.firstName ? [{ key: "name", label: "NAME", value: appt.firstName }] : []),
        ...(address ? [{ key: "where", label: "WHERE", value: address }] : []),
      ],
      backFields: [
        { key: "manage", label: "Reschedule or cancel", value: manageUrl },
        {
          key: "auto",
          label: "This pass updates itself",
          value:
            "If the time changes or the appointment is canceled, the pass refreshes on its own.",
        },
      ],
    },
  };

  const pass = new PKPass(
    {
      "pass.json": Buffer.from(JSON.stringify(passJson)),
      ...loadArt(),
    },
    loadApptCerts(),
  );
  return pass.getAsBuffer();
}

/**
 * Tell every registered device holding this APPOINTMENT's pass to re-fetch it
 * - after a reschedule (new time) or a cancellation (voided). Best-effort and
 * NEVER throws: a wallet problem must not break a booking mutation. Callers
 * on the booking paths ignore the result; it exists for tests and admin
 * surfaces, with the same vocabulary as the punch-card poke.
 */
export async function pokeAppointmentPass(
  appointmentId: string,
): Promise<WalletPokeResult> {
  let regs: Array<{ id: string; pushToken: string }>;
  try {
    regs = await runAsOwner((tx) =>
      tx.walletAppointmentPassRegistration.findMany({
        where: { appointmentId },
        select: { id: true, pushToken: true },
      }),
    );
  } catch {
    logger.error(
      { appointmentId, reason: "registration_lookup_failed" },
      "appointment pass poke unavailable",
    );
    return "retryable_unavailable";
  }
  if (regs.length === 0) return "nothing_to_do";

  if (!appointmentWalletEnabled() || env.DRY_RUN) {
    logger.info(
      { appointmentId, reason: appointmentWalletEnabled() ? "suppressed" : "unconfigured" },
      "appointment pass poke not dispatched",
    );
    return "retryable_unavailable";
  }

  let apptCerts: WalletCerts;
  try {
    apptCerts = loadApptCerts();
  } catch {
    logger.error(
      { appointmentId, reason: "certs_unreadable" },
      "appointment pass poke unavailable",
    );
    return "retryable_unavailable";
  }

  return pokeApnsRegistrations({
    regs,
    topic: env.WALLET_APPT_PASS_TYPE_ID!,
    certs: apptCerts,
    logKey: { appointmentId },
    prune: (regId) =>
      runAsOwner((tx) =>
        tx.walletAppointmentPassRegistration.deleteMany({ where: { id: regId } }),
      ).then(() => undefined),
  });
}
