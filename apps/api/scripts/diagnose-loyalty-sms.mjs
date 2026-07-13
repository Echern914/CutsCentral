/**
 * Diagnose why a loyalty SMS didn't send — READ ONLY by default.
 *
 * Finds a client by phone (across all shops on the connected DB) and prints,
 * gate by gate, exactly why notifyPunchEarned would (or wouldn't) send them a
 * real text. Mirrors the live gates in services/loyaltyNotify.ts + billing/
 * stripe.ts, so a PASS here means a logged visit WILL text (unless a push
 * device intercepts it first — which this also reports).
 *
 * Connects to whatever DATABASE_URL is set. To point at PROD, uncomment
 * PROD_DATABASE_URL in the repo .env and run:
 *
 *   node apps/api/scripts/diagnose-loyalty-sms.mjs --phone +12019144210
 *
 * With --fix it will, for the SINGLE matched client, stamp consent + clear an
 * opt-out (source "barber_attest") so the next logged visit can text — the one
 * safe, reversible write. It NEVER changes shop toggles, billing, or DRY_RUN.
 */
import { config } from "dotenv";
config();

import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

// Prefer an explicit prod URL if the operator uncommented it; else DATABASE_URL.
const url = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No PROD_DATABASE_URL or DATABASE_URL in env. Set one and retry.");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const argPhone = argOf("--phone");
const argClient = argOf("--client"); // scope --fix to exactly this client id
const doFix = process.argv.includes("--fix");
if (!argPhone) {
  console.error('Usage: node diagnose-loyalty-sms.mjs --phone "+12019144210" [--fix]');
  process.exit(1);
}

// Normalize the phone to E.164 the way the app does (toE164): strip non-digits,
// assume US (+1) for 10 digits, accept a leading 1 for 11. So the lookup matches
// however the row was stored.
function toE164(raw) {
  const d = String(raw).replace(/[^\d]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (String(raw).startsWith("+")) return "+" + d;
  return null;
}
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
function hasActiveAccess(shop, now) {
  if (shop.compAccess) return true;
  // We can't read env STRIPE_* here reliably, so assume billing is ENABLED
  // (it is, in prod) — the strict case. A comped/trialing/active shop passes.
  if (ACTIVE_STATUSES.has(shop.subscriptionStatus)) return true;
  return shop.trialEndsAt !== null && shop.trialEndsAt.getTime() > now.getTime();
}

// TCPA quiet hours: texts only 8:00–20:59 shop-local (the app blocks < 8 or >= 21).
function inQuietHours(timezone, now) {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        hour12: false,
      }).format(now),
    );
    return hour < 8 || hour >= 21;
  } catch {
    return false;
  }
}

function line(ok, label, detail) {
  const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "····";
  console.log(`  [${mark}] ${label}${detail ? " — " + detail : ""}`);
}

const main = async () => {
  const e164 = toE164(argPhone);
  const now = new Date();
  console.log(`\nDiagnosing loyalty SMS for phone ${argPhone}  (normalized ${e164})`);
  console.log(`DB host: ${url.replace(/:[^:@/]+@/, ":****@").split("@")[1]?.split("/")[0] ?? "?"}`);
  console.log(`Now (UTC): ${now.toISOString()}\n`);

  // Match on the normalized number OR the raw string, so we find it however stored.
  const clients = await prisma.client.findMany({
    where: { OR: [{ phone: e164 }, { phone: argPhone }] },
    include: {
      shop: {
        select: {
          id: true,
          name: true,
          timezone: true,
          loyaltyTextsEnabled: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          compAccess: true,
        },
      },
      pushSubscriptions: { select: { id: true, kind: true } },
    },
  });

  if (clients.length === 0) {
    console.log("NO CLIENT FOUND with that phone on this database.");
    console.log("=> This is the reason. The visit you logged is on a client whose");
    console.log("   phone is stored differently (or blank), or on a different DB/shop.");
    console.log("   Fix: open the client in the dashboard and confirm the phone reads");
    console.log(`   exactly ${e164}, then re-log the visit.`);
    return;
  }

  for (const c of clients) {
    const s = c.shop;
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`Client: ${c.firstName ?? "(no name)"} ${c.lastName ?? ""}  [${c.id}]`);
    console.log(`Shop:   ${s?.name ?? "(no shop)"}  [${s?.id}]  tz=${s?.timezone}\n`);

    const gates = [];
    gates.push(["shop.loyaltyTextsEnabled is ON", s?.loyaltyTextsEnabled === true,
      s?.loyaltyTextsEnabled ? "on" : "OFF — turn on Loyalty texts for THIS shop"]);
    const access = s ? hasActiveAccess(s, now) : false;
    gates.push(["shop has active access (billing/trial/comp)", access,
      `status=${s?.subscriptionStatus}, trialEndsAt=${s?.trialEndsAt?.toISOString() ?? "null"}, comp=${s?.compAccess}`]);
    gates.push(["client not archived", c.archivedAt === null,
      c.archivedAt ? "ARCHIVED" : "ok"]);
    gates.push(["client not opted out", c.optedOut === false,
      c.optedOut ? `OPTED OUT (source=${c.optOutSource ?? "?"})` : "ok"]);
    gates.push(["client has SMS consent (smsConsentAt set)", c.smsConsentAt !== null,
      c.smsConsentAt ? `since ${c.smsConsentAt.toISOString()} (src=${c.smsConsentSource ?? "?"})` : "NO CONSENT — mark consent on the client"]);
    gates.push(["client has a phone", Boolean(c.phone), c.phone ?? "MISSING"]);
    const quiet = s ? inQuietHours(s.timezone, now) : false;
    gates.push(["not in quiet hours (8am–9pm shop-local)", !quiet,
      quiet ? "QUIET HOURS now — wait for daytime" : "ok (daytime)"]);

    console.log("Loyalty SMS gates:");
    for (const [label, ok, detail] of gates) line(ok, label, detail);

    const firstFail = gates.find((g) => g[1] !== true);
    const pushCount = c.pushSubscriptions.length;
    console.log("");
    line(pushCount === 0, "no push device would intercept the SMS",
      pushCount === 0
        ? "no push subs — a logged visit falls through to SMS"
        : `${pushCount} push sub(s): ${c.pushSubscriptions.map((p) => p.kind).join(", ")} — PUSH goes FIRST, so you'd get an app notification, NOT a text`);

    console.log("");
    if (!firstFail && pushCount === 0) {
      console.log("VERDICT: All gates pass and no push device — a logged visit SHOULD text.");
      console.log("If it still didn't, check Railway logs for 'loyalty SMS send failed'");
      console.log("(a Twilio-side error: unregistered number, A2P, geo-permissions).");
    } else if (!firstFail && pushCount > 0) {
      console.log("VERDICT: All SMS gates pass, BUT this client has push devices.");
      console.log("=> Your logged visit sent a PUSH (app notification), not an SMS —");
      console.log("   that's the cost-saving 'push-first' behavior, working as designed.");
      console.log("   To test SMS specifically: use a client with NO push subscription");
      console.log("   (one whose rewards page you've never opened with notifications on),");
      console.log("   or turn off app notifications for this number, then re-log a visit.");
    } else {
      console.log(`VERDICT: BLOCKED by → ${firstFail[0]}`);
      console.log(`   detail: ${firstFail[2]}`);
    }

    // --fix: the one safe write — make THIS client textable (consent + un-opt-out).
    // Only writes when the fix is UNAMBIGUOUS: either exactly one client matched
    // the phone, OR --client pins the exact id (required when several clients
    // share the number, so we never touch the wrong row).
    const fixTargetsThis = argClient ? c.id === argClient : clients.length === 1;
    if (doFix && fixTargetsThis) {
      const needsConsent = c.smsConsentAt === null;
      const needsUnstop = c.optedOut === true && c.optOutSource !== "sms_stop";
      if (needsConsent || needsUnstop) {
        await prisma.client.update({
          where: { id: c.id },
          data: {
            ...(needsConsent
              ? { smsConsentAt: new Date(), smsConsentSource: "barber_attest" }
              : {}),
            ...(needsUnstop ? { optedOut: false, optOutSource: null } : {}),
          },
        });
        console.log("\n[--fix] Applied: " +
          [needsConsent ? "stamped consent (barber_attest)" : null,
           needsUnstop ? "cleared barber opt-out" : null].filter(Boolean).join(" + "));
        console.log("        Re-run WITHOUT --fix to confirm, then log a visit.");
      } else if (c.optedOut && c.optOutSource === "sms_stop") {
        console.log("\n[--fix] NOT applied: this client texted STOP. Only the client can");
        console.log("        re-opt-in (reply START from the phone, or the rewards page).");
      } else {
        console.log("\n[--fix] Nothing to fix on consent/opt-out (those gates already pass).");
      }
    }
  }
};

main()
  .catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
