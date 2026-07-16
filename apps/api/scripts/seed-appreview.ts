import crypto from "node:crypto";
import "../src/env-bootstrap.js";
import { prisma } from "@chairback/db";
import { hashPassword } from "../src/auth/password.js";

/**
 * Seed (or refresh) the App Store REVIEW account: a real email+password user
 * with a fully-populated shop, so Apple's reviewer can sign in with typed
 * credentials (App Review only accepts username+password demo accounts -
 * Guideline 2.1(a)) and exercise every barber feature with WRITE access.
 *
 * This is deliberately NOT the public demo tenant (seedDemoShop.ts): demo
 * sessions are read-only and its owner has no password, neither of which
 * satisfies "verify all app features and functionality". Same defusing rules
 * apply though - every text toggle off, dailySendCap 0, fictional 202-555
 * phone numbers - so nothing here can ever send a real SMS.
 *
 * Idempotent: each run deletes the review user's shops (cascade) and reseeds,
 * which also mints FRESH customer rewards links - rerun after a reviewer
 * exercises the customer-deletion flow (deletion rotates that magic token).
 *
 * Usage (from repo root, env loaded; against prod: run on Railway):
 *   pnpm --filter @chairback/api review:seed <password>
 *   pnpm --filter @chairback/api review:seed <password> --email you@x.com --force
 *
 * Prints the credentials + rewards links to paste into App Store Connect's
 * App Review Information.
 */

const DEFAULT_EMAIL = "appreview@getchairback.com";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

interface CastEntry {
  firstName: string;
  lastName: string;
  phone: string; // 202-555 fictional range, matching seedDemoShop's cast
  visits: number;
  intervalDays: number;
  lastVisitDaysAgo: number;
  cadence: "WEEKLY" | "BIWEEKLY" | "EVERY_3_WEEKS" | "MONTHLY" | "OCCASIONAL";
  tier: "BRONZE" | "SILVER" | "GOLD" | null;
  optedOut?: boolean;
  /** Punches redeemed via a non-visit ledger entry (shows redemption history). */
  redeemed?: number;
}

// Variety on purpose: a Gold regular mid-card, a reward READY, an overdue
// at-risk row, a fresh face, an opted-out client - so every dashboard surface
// (stats, at-risk radar, activity, consent states, rewards) has real rows.
const CAST: CastEntry[] = [
  { firstName: "Marcus", lastName: "Reed", phone: "+12025550171", visits: 12, intervalDays: 7, lastVisitDaysAgo: 3, cadence: "WEEKLY", tier: "GOLD", redeemed: 5 },
  { firstName: "Jasmine", lastName: "Cole", phone: "+12025550172", visits: 6, intervalDays: 14, lastVisitDaysAgo: 5, cadence: "BIWEEKLY", tier: "SILVER" },
  { firstName: "Andre", lastName: "Booker", phone: "+12025550173", visits: 4, intervalDays: 21, lastVisitDaysAgo: 40, cadence: "EVERY_3_WEEKS", tier: "BRONZE" },
  { firstName: "Terrell", lastName: "James", phone: "+12025550174", visits: 1, intervalDays: 30, lastVisitDaysAgo: 10, cadence: "MONTHLY", tier: "BRONZE" },
  { firstName: "Sofia", lastName: "Marin", phone: "+12025550175", visits: 8, intervalDays: 14, lastVisitDaysAgo: 2, cadence: "BIWEEKLY", tier: "SILVER" },
  { firstName: "Deshawn", lastName: "Price", phone: "+12025550176", visits: 2, intervalDays: 30, lastVisitDaysAgo: 30, cadence: "OCCASIONAL", tier: "BRONZE", optedOut: true },
  { firstName: "Lena", lastName: "Ortiz", phone: "+12025550177", visits: 5, intervalDays: 30, lastVisitDaysAgo: 12, cadence: "MONTHLY", tier: "BRONZE" },
  { firstName: "Alex", lastName: "Rivera", phone: "+12025550178", visits: 4, intervalDays: 14, lastVisitDaysAgo: 6, cadence: "BIWEEKLY", tier: "BRONZE" },
];

/** The links App Review needs: [0] browse-everything, [1] deletion test. */
const BROWSE = "Marcus";
const DELETE_TEST = "Alex";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const password = args.find((a) => !a.startsWith("--") && a !== emailArg());
  const email = (emailArg() ?? DEFAULT_EMAIL).toLowerCase();
  const force = args.includes("--force");

  function emailArg(): string | undefined {
    const i = process.argv.indexOf("--email");
    return i === -1 ? undefined : process.argv[i + 1];
  }

  if (!password || password.length < 8) {
    console.error("Usage: review:seed <password (8+ chars)> [--email x@y.com --force]");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    include: { shops: { select: { id: true, stripeSubscriptionId: true } } },
  });
  // Reseeding DELETES this user's shops. The default review address is ours to
  // wreck; anything else needs --force, and a shop with a live Stripe sub is
  // never fair game (that's a real customer, not a review fixture).
  if (existing) {
    if (email !== DEFAULT_EMAIL && !force) {
      console.error(`${email} already exists - pass --force to reseed a non-default email.`);
      process.exit(1);
    }
    if (existing.shops.some((s) => s.stripeSubscriptionId)) {
      console.error(`${email} owns a shop with a live Stripe subscription - refusing.`);
      process.exit(1);
    }
    await prisma.shop.deleteMany({ where: { ownerId: existing.id } });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    // welcomeSeenAt: land the reviewer straight on the dashboard, not the
    // barber onboarding tour.
    update: { passwordHash, welcomeSeenAt: new Date() },
    create: {
      email,
      name: "Uptown Fades",
      passwordHash,
      smsAttestedAt: new Date(),
      welcomeSeenAt: new Date(),
    },
  });

  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Uptown Fades",
      timezone: "America/New_York",
      industry: "barber",
      // Full Premium without Stripe: nothing in the app may ask for money
      // (Guideline 3.1.1), and the reviewer must see Premium features working.
      compAccess: true,
      rewardsEnabled: true,
      punchesPerVisit: 1,
      rebookWindowDays: 14,
      // Defused outbound: fictional numbers + every text switch off +
      // dailySendCap 0 as the hard kill switch (mirrors seedDemoShop).
      dailySendCap: 0,
      loyaltyTextsEnabled: false,
      winbackTextsEnabled: false,
      takesRequests: false,
      webhookSecret: crypto.randomBytes(24).toString("hex"),
    },
  });

  const freeCut = await prisma.reward.create({
    data: { shopId: shop.id, name: "Free Cut", emoji: "✂️", punchCost: 10, sortOrder: 0 },
  });
  const beardTrim = await prisma.reward.create({
    data: { shopId: shop.id, name: "Free Beard Trim", emoji: "🧔", punchCost: 5, sortOrder: 1 },
  });

  const links: Record<string, string> = {};

  for (const c of CAST) {
    const lastVisitAt = daysAgo(c.lastVisitDaysAgo);
    const magicToken = crypto.randomUUID();
    const client = await prisma.client.create({
      data: {
        shopId: shop.id,
        acuityClientKey: c.phone,
        firstName: c.firstName,
        lastName: c.lastName,
        phone: c.phone,
        source: "manual",
        magicToken,
        optedOut: c.optedOut ?? false,
        optOutSource: c.optedOut ? "manual" : null,
        smsConsentAt: c.optedOut ? null : new Date(),
        smsConsentSource: c.optedOut ? null : "manual",
        preferredCadence: c.cadence,
        loyaltyTier: c.tier,
        medianIntervalDays: c.visits >= 2 ? c.intervalDays : null,
        lastVisitAt,
        nextExpectedAt: new Date(lastVisitAt.getTime() + c.intervalDays * 86_400_000),
      },
    });
    links[c.firstName] = `https://getchairback.com/r/${magicToken}`;

    for (let i = 1; i <= c.visits; i++) {
      const scheduledAt = new Date(
        lastVisitAt.getTime() - (c.visits - i) * c.intervalDays * 86_400_000,
      );
      const endAt = new Date(scheduledAt.getTime() + 30 * 60_000);
      const serviceName = i % 3 === 0 ? "Cut + Beard" : "Haircut";
      const visit = await prisma.visit.create({
        data: {
          shopId: shop.id,
          clientId: client.id,
          acuityAppointmentId: `review:${c.firstName.toLowerCase()}:v${i}`,
          status: "COMPLETED",
          scheduledAt,
          endAt,
          completedAt: endAt,
          price: serviceName === "Haircut" ? 35 : 50,
          serviceName,
        },
      });
      await prisma.punchLedger.create({
        data: {
          shopId: shop.id,
          clientId: client.id,
          visitId: visit.id,
          punchesEarned: 1,
          runningBalance: i,
          createdAt: endAt,
        },
      });
    }
    if (c.redeemed) {
      await prisma.punchLedger.create({
        data: {
          shopId: shop.id,
          clientId: client.id,
          rewardId: c.redeemed >= freeCut.punchCost ? freeCut.id : beardTrim.id,
          punchesRedeemed: c.redeemed,
          runningBalance: c.visits - c.redeemed,
          note: "Redeemed",
          createdAt: daysAgo(c.lastVisitDaysAgo + 1),
        },
      });
    }
  }

  console.log(`
App Store Connect -> App Review Information
============================================
Barber/manager demo (sign in with EMAIL on the app's sign-in screen):
  Email:    ${email}
  Password: ${password}

Customer demo (app -> "I'm a customer" -> paste link):
  Browse (punches, rewards, visit history):
    ${links[BROWSE]}
  Deletion test (Delete my data - kills THIS link only; rerun this script to mint a new one):
    ${links[DELETE_TEST]}

Shop: "${shop.name}" (${CAST.length} clients, comped Premium, all SMS sending disabled)
`);
  await prisma.$disconnect();
}

void main();
