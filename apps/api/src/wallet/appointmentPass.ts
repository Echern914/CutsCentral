import { createHmac, timingSafeEqual } from "node:crypto";
import { PKPass } from "passkit-generator";
import { apiEnv } from "@chairback/config";
import { describeCancellationPolicy } from "@chairback/config/shopPolicy";
import { formatShopAddress } from "@chairback/config/shopAddress";
import { runAsOwner } from "@chairback/db";
import { connectEnabled } from "../billing/stripe.js";
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
 * "2:00 - 2:30 PM" in the SHOP's timezone.
 *
 * 🔴 BOTH ENDS, IN ONE FIELD. The pass used to print the start only, which is
 * the single question a customer in a chair cannot answer from it: "how long
 * am I here for?". One field rather than two because Wallet gives an
 * eventTicket very little room, and a range is read at a glance where a
 * separate ENDS row is not.
 *
 * The timezone is the SHOP's, never the phone's. A customer who books in one
 * city and opens the pass in another must still see the time they are expected.
 */
function faceTimeRange(startsAt: Date, endsAt: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    });
    const start = fmt.format(startsAt);
    const end = fmt.format(endsAt);
    // "2:00 PM - 2:30 PM" reads better as "2:00 - 2:30 PM" when the meridiem
    // matches; when it straddles noon or midnight both have to stay.
    const startMeridiem = start.slice(-2);
    const endMeridiem = end.slice(-2);
    return startMeridiem === endMeridiem
      ? `${start.slice(0, -3)} - ${end}`
      : `${start} - ${end}`;
  } catch {
    return `${startsAt.toUTCString().slice(17, 22)} - ${endsAt.toUTCString().slice(17, 22)}`;
  }
}

/**
 * The short confirmation reference a customer reads out on the phone.
 *
 * 🔴 A HANDLE, NOT A SECRET. It is derived from the appointment id, which is
 * already the pass serial number and is already visible to anyone holding the
 * pass. Nothing authenticates on it - the manageToken does that - so shortening
 * it costs nothing. It exists because "my confirmation is CJ4K2P" is sayable
 * and a 25-character cuid is not.
 */
export function confirmationReference(appointmentId: string): string {
  return appointmentId.slice(-6).toUpperCase();
}

/**
 * Everything the pass face needs, which is exactly what the query below
 * selects. Written out rather than inferred from Prisma so the CONTENT of a
 * pass can be tested without a database and, more importantly, without an
 * Apple certificate - the fields a customer reads are the part with all the
 * requirements in it, and signing is a separate concern.
 */
export interface AppointmentPassSource {
  /**
   * CAN this shop actually take a card right now (Connect live + charges
   * enabled + an account)? An INPUT rather than something computed here,
   * because it depends on process env and this function must stay pure - a
   * pass face that changes with an environment variable is not testable, and
   * the cancellation sentence is exactly the field where being wrong costs a
   * customer money.
   */
  paymentsLive: boolean;
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  firstName: string | null;
  manageToken: string;
  service: { name: string } | null;
  staff: { name: string } | null;
  shop: {
    name: string;
    timezone: string;
    accentColor: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressRegion: string | null;
    addressPostal: string | null;
    latitude: number | null;
    longitude: number | null;
    twilioNumber: string | null;
    paymentsMode: "off" | "ahead" | "deposit" | "card_on_file" | "hold" | "terminal";
    cancelWindowHours: number;
    cancelFeeBps: number;
    depositAmountCents: number | null;
    requireBookingApproval: boolean;
    connectChargesEnabled: boolean;
    stripeConnectAccountId: string | null;
    chargeCardOnFileFees: boolean;
  };
}

/**
 * The pass.json for one appointment. PURE - no database, no certificate, no
 * clock beyond the appointment's own instants - so every field a customer
 * reads is testable on its own.
 *
 * A canceled/completed appointment yields a VOIDED pass (Wallet greys it out)
 * because the devices that already added it re-fetch through here after a
 * poke, and "this is no longer valid" must be sayable. Whether a FRESH
 * download is allowed at all is the route's decision, not this builder's.
 */
export function buildAppointmentPassJson(
  appt: AppointmentPassSource,
): Record<string, unknown> {

  const manageUrl = `${env.APP_BASE_URL}/book/manage/${appt.manageToken}`;
  const { date } = faceLabels(appt.startsAt, appt.shop.timezone);
  const when = faceTimeRange(appt.startsAt, appt.endsAt, appt.shop.timezone);
  // 🔴 THE ONE ADDRESS FORMATTER. This file used to join the three columns by
  // hand, which is how a second, quietly different version of the shop's
  // address starts existing - the email, the reminder and the pass have to
  // agree about where the shop is.
  const address = formatShopAddress(appt.shop);
  const reference = confirmationReference(appt.id);
  const live = LIVE_STATUSES.has(appt.status);

  // What happens if they cancel, in the SAME words the receptionist and the
  // confirmation email use. No channel override: this booking came through a
  // surface that does collect at booking when the shop is set up to, so
  // claiming otherwise would understate a fee the customer may really owe.
  const cancellationPolicy = describeCancellationPolicy({
    paymentsMode: appt.shop.paymentsMode,
    cancelWindowHours: appt.shop.cancelWindowHours,
    cancelFeeBps: appt.shop.cancelFeeBps,
    depositAmountCents: appt.shop.depositAmountCents,
    requiresApproval: appt.shop.requireBookingApproval,
    chargeCardOnFileFees: appt.shop.chargeCardOnFileFees,
    paymentsLive: appt.paymentsLive,
  });

  return {
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
    // Lock-screen relevance AT THE SHOP, not just near the time. Emitted only
    // when the shop has real coordinates: Apple takes lat/lng and nothing else,
    // and a guessed point would buzz a customer at the wrong building, which is
    // worse than never buzzing at all.
    ...(appt.shop.latitude !== null && appt.shop.longitude !== null
      ? {
          locations: [
            {
              latitude: appt.shop.latitude,
              longitude: appt.shop.longitude,
              relevantText: `${appt.shop.name} - ${when}`,
            },
          ],
        }
      : {}),
    ...(live ? {} : { voided: true }),
    logoText: appt.shop.name,
    backgroundColor: "rgb(10,10,11)",
    foregroundColor: "rgb(245,245,244)",
    labelColor: hexToRgb(appt.shop.accentColor, "rgb(212,175,55)"),
    eventTicket: {
      headerFields: [{ key: "ref", label: "CONFIRMATION", value: reference }],
      primaryFields: [
        {
          key: "when",
          label: live ? date.toUpperCase() : "CANCELED",
          value: when,
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
        ...(address ? [{ key: "address", label: "Address", value: address }] : []),
        ...(appt.shop.twilioNumber
          ? [{ key: "phone", label: "Phone", value: appt.shop.twilioNumber }]
          : []),
        { key: "manage", label: "Reschedule or cancel", value: manageUrl },
        // 🔴 The policy in the SAME words the confirmation email and the SMS
        // receptionist use (@chairback/config/shopPolicy). A pass that a
        // customer keeps for weeks is exactly the wrong place for a second,
        // drifting copy of what a late cancellation costs.
        { key: "policy", label: "Cancellation policy", value: cancellationPolicy },
        {
          key: "auto",
          label: "This pass updates itself",
          value:
            "If the time changes or the appointment is canceled, the pass refreshes on its own.",
        },
      ],
    },
  };

}

/**
 * Build + SIGN the current pass for one appointment. Returns null when the
 * appointment is gone. The content decision lives in
 * buildAppointmentPassJson; this function is the database read and the
 * certificate, and nothing else.
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
            addressPostal: true,
            // Apple Wallet location relevance. Null on most shops; see schema.
            latitude: true,
            longitude: true,
            // The shop's PUBLIC line. 🔴 Deliberately twilioNumber and never
            // notifyPhone: notifyPhone is the barber's own mobile, kept for
            // lead-alert texts, and printing it on a pass every customer keeps
            // would publish a private number to everyone who ever books.
            twilioNumber: true,
            // Everything describeCancellationPolicy() needs to tell the truth.
            paymentsMode: true,
            cancelWindowHours: true,
            cancelFeeBps: true,
            depositAmountCents: true,
            requireBookingApproval: true,
            connectChargesEnabled: true,
            stripeConnectAccountId: true,
            chargeCardOnFileFees: true,
          },
        },
      },
    }),
  );
  if (!appt) return null;

  // Resolved HERE, where reading the environment is fine, and handed to the
  // content builder as a plain fact.
  const paymentsLive =
    connectEnabled() &&
    appt.shop.connectChargesEnabled &&
    Boolean(appt.shop.stripeConnectAccountId);

  const pass = new PKPass(
    {
      "pass.json": Buffer.from(
        JSON.stringify(buildAppointmentPassJson({ ...appt, paymentsLive })),
      ),
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
