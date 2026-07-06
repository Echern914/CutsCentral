import { createHmac, timingSafeEqual } from "node:crypto";
import { connect as http2Connect } from "node:http2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PKPass } from "passkit-generator";
import { apiEnv } from "@chairback/config";
import { prisma, runAsOwner } from "@chairback/db";
import { currentBalance } from "../services/punch.js";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Apple Wallet punch card. A signed .pkpass storeCard showing the client's
 * punch balance + progress toward their next reward, branded per shop. Two
 * halves:
 *   1. Pass GENERATION (buildPassForClient): pass.json + art, signed with the
 *      Pass Type ID certificate (passkit-generator does manifest + PKCS#7).
 *   2. Auto-UPDATE: devices register via the PassKit Web Service protocol
 *      (routes/wallet.ts); when punches change we send an EMPTY APNs push on
 *      the pass-type topic (pokeWalletPass) and each device re-fetches its
 *      pass. The SAME certificate authenticates those APNs pokes.
 *
 * Everything is gated on walletEnabled(): until the five WALLET_* env vars are
 * set (see packages/config env.ts), the button hides and the routes 404 - the
 * Stripe/Resend/VAPID "dark until configured" pattern.
 */

export function walletEnabled(): boolean {
  return Boolean(
    env.WALLET_PASS_TYPE_ID &&
      env.WALLET_TEAM_ID &&
      env.WALLET_PASS_CERT_BASE64 &&
      env.WALLET_PASS_KEY_BASE64 &&
      env.WALLET_WWDR_CERT_BASE64,
  );
}

/**
 * The pass's authenticationToken (PassKit requires >=16 chars; devices send it
 * back as `Authorization: ApplePass <token>` on every web-service call).
 * Stateless: an HMAC of the client id under SESSION_SECRET, so there is no
 * token table and a DB leak reveals nothing usable without the secret.
 */
export function passAuthToken(clientId: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`wallet-pass:${clientId}`)
    .digest("hex");
}

/** Constant-time check of the ApplePass authorization header for one pass. */
export function verifyPassAuth(header: string | undefined, clientId: string): boolean {
  if (!header?.startsWith("ApplePass ")) return false;
  const presented = Buffer.from(header.slice("ApplePass ".length));
  const expected = Buffer.from(passAuthToken(clientId));
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// Signing material, decoded once. Lazy so boot never depends on wallet config.
let certs: { wwdr: string; signerCert: string; signerKey: string; signerKeyPassphrase?: string } | null = null;
function loadCerts() {
  if (!certs) {
    certs = {
      wwdr: Buffer.from(env.WALLET_WWDR_CERT_BASE64!, "base64").toString("utf8"),
      signerCert: Buffer.from(env.WALLET_PASS_CERT_BASE64!, "base64").toString("utf8"),
      signerKey: Buffer.from(env.WALLET_PASS_KEY_BASE64!, "base64").toString("utf8"),
      ...(env.WALLET_PASS_KEY_PASSPHRASE
        ? { signerKeyPassphrase: env.WALLET_PASS_KEY_PASSPHRASE }
        : {}),
    };
  }
  return certs;
}

// Pass art, read once from the assets folder next to this module (the API runs
// via tsx from src, so import.meta.url-relative paths hold in prod).
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
let art: Record<string, Buffer> | null = null;
function loadArt(): Record<string, Buffer> {
  if (!art) {
    art = Object.fromEntries(
      ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png"].map(
        (f) => [f, readFileSync(path.join(ASSETS_DIR, f))],
      ),
    );
  }
  return art;
}

/** "#D4AF37" -> "rgb(212,175,55)" (pass.json colors must be rgb() strings). */
function hexToRgb(hex: string | null, fallback: string): string {
  const m = hex?.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

/**
 * Build + sign the CURRENT pass for one client. Public-path trust model: the
 * caller has already authenticated (magicToken route or ApplePass token), so
 * reads run as owner. Returns null when the client is gone.
 */
export async function buildPassForClient(clientId: string): Promise<Buffer | null> {
  const data = await runAsOwner(async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        firstName: true,
        magicToken: true,
        shop: { select: { id: true, name: true, accentColor: true } },
      },
    });
    if (!client) return null;
    // The pass shows the DEFAULT card's view (cardTypeId null) - same as the
    // rewards page's top-level balance. Identical to the total for every shop
    // without custom card types.
    const [balance, rewards] = await Promise.all([
      currentBalance(client.shop.id, client.id, null, tx),
      tx.reward.findMany({
        where: { shopId: client.shop.id, active: true, cardTypeId: null },
        orderBy: { punchCost: "asc" },
        select: { name: true, punchCost: true },
      }),
    ]);
    return { client, balance, rewards };
  });
  if (!data) return null;

  const { client, balance, rewards } = data;
  const nextTarget = rewards.find((r) => r.punchCost > balance) ?? null;
  const rewardsUrl = `${env.APP_BASE_URL}/r/${client.magicToken}`;

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env.WALLET_PASS_TYPE_ID!,
    teamIdentifier: env.WALLET_TEAM_ID!,
    organizationName: client.shop.name,
    description: `${client.shop.name} punch card`,
    serialNumber: client.id,
    webServiceURL: `${env.API_BASE_URL}/api/wallet`,
    authenticationToken: passAuthToken(client.id),
    sharingProhibited: true,
    logoText: client.shop.name,
    // Brand-dark card with the shop's accent (default: ChairBack gold) as the
    // label color - mirrors the app + rewards page chrome.
    backgroundColor: "rgb(10,10,11)",
    foregroundColor: "rgb(245,245,244)",
    labelColor: hexToRgb(client.shop.accentColor, "rgb(212,175,55)"),
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: rewardsUrl,
        messageEncoding: "iso-8859-1",
        altText: "Your rewards",
      },
    ],
    storeCard: {
      primaryFields: [
        {
          key: "balance",
          label: "PUNCHES",
          value: balance,
          // The lock-screen line Wallet shows when an update lands.
          changeMessage: "You now have %@ punches",
        },
      ],
      secondaryFields: nextTarget
        ? [
            {
              key: "next",
              label: `NEXT: ${nextTarget.name.toUpperCase()}`,
              value: `${balance} of ${nextTarget.punchCost}`,
            },
            { key: "member", label: "MEMBER", value: client.firstName },
          ]
        : [{ key: "member", label: "MEMBER", value: client.firstName }],
      backFields: [
        { key: "rewards", label: "Your rewards page", value: rewardsUrl },
        {
          key: "how",
          label: "How it works",
          value:
            "Every visit earns punches. This card updates by itself - show the code or open your rewards page to redeem.",
        },
      ],
    },
  };

  const pass = new PKPass(
    {
      "pass.json": Buffer.from(JSON.stringify(passJson)),
      ...loadArt(),
    },
    loadCerts(),
  );
  return pass.getAsBuffer();
}

/**
 * Tell every registered device holding this client's pass to re-fetch it - an
 * EMPTY APNs push on the pass-type topic, authenticated with the pass
 * certificate over HTTP/2. Called after punch changes (earn/redeem/bonus).
 * Best-effort like every send path: never throws, prunes 410-Unregistered.
 */
export async function pokeWalletPass(clientId: string): Promise<void> {
  if (!walletEnabled()) return;
  let regs: Array<{ id: string; pushToken: string }>;
  try {
    regs = await runAsOwner((tx) =>
      tx.walletPassRegistration.findMany({
        where: { clientId },
        select: { id: true, pushToken: true },
      }),
    );
  } catch (err) {
    logger.error({ err, clientId }, "wallet poke registration lookup failed");
    return;
  }
  if (regs.length === 0) return;
  if (env.DRY_RUN) {
    logger.info({ clientId, devices: regs.length }, "[dry-run] suppressed wallet pass poke");
    return;
  }

  const { signerCert, signerKey, signerKeyPassphrase } = loadCerts();
  await new Promise<void>((resolve) => {
    const session = http2Connect("https://api.push.apple.com", {
      cert: signerCert,
      key: signerKey,
      ...(signerKeyPassphrase ? { passphrase: signerKeyPassphrase } : {}),
    });
    // One watchdog for the whole batch: APNs pokes are tiny, so a hung session
    // must never hold up the punch flow that triggered us.
    const timer = setTimeout(() => {
      session.destroy();
      resolve();
    }, 5000);
    session.on("error", (err) => {
      logger.warn({ err, clientId }, "wallet poke APNs session error");
      clearTimeout(timer);
      resolve();
    });

    let pending = regs.length;
    const done = () => {
      if (--pending === 0) {
        clearTimeout(timer);
        session.close();
        resolve();
      }
    };
    for (const reg of regs) {
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${reg.pushToken}`,
        "apns-topic": env.WALLET_PASS_TYPE_ID!,
      });
      req.setEncoding("utf8");
      let status = 0;
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("close", () => {
        if (status === 410) {
          // Device no longer has the pass: drop the registration.
          runAsOwner((tx) =>
            tx.walletPassRegistration.deleteMany({ where: { id: reg.id } }),
          ).catch(() => {});
        } else if (status !== 200) {
          logger.warn({ status, clientId }, "wallet pass poke rejected");
        }
        done();
      });
      req.on("error", () => done());
      // Pass-update pushes carry an EMPTY payload; the push itself is the signal.
      req.end("{}");
    }
  });
}
