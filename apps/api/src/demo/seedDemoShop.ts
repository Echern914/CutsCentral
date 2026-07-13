import crypto from "node:crypto";
import { prisma } from "@chairback/db";
import { DEMO, addDays, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";

/**
 * Seed (or restore) the live-demo tenant: "Fade District", slug `demo` — the
 * fully-loaded shop the guided client tour (see packages/config/src/demoTour.ts)
 * walks through. Canonical-state by construction: every run WIPES the demo
 * shop's children and recreates them, so it doubles as the nightly reset
 * (engines/demoReset.ts) that clears viewer-submitted junk and re-rolls dates
 * (the showcase appointment is always "tomorrow", the last visit ~5 days ago —
 * fresh countdowns, and the demo client never lapses into the nudge/win-back
 * sweeps' selection windows).
 *
 * Everything notification-adjacent is defused: all SMS/text toggles off, the
 * client's phone is a Twilio magic number, and the showcase appointment is
 * pre-stamped as already-confirmed/reminded on every channel so no engine ever
 * attempts an outbound send for it.
 */

const TZ = "America/New_York";

/** Local wall-clock instant `daysFromNow` days out at `minutes` past midnight. */
function localTime(daysFromNow: number, minutes: number): Date {
  const parts = zonedDateParts(addDays(new Date(), daysFromNow), TZ);
  return zonedWallTimeToUtc(parts.year, parts.month0, parts.day, minutes, TZ);
}

export interface DemoSeedResult {
  shopId: string;
  slug: string;
  clientMagicToken: string;
  appointmentManageToken: string;
}

export async function seedDemoShop(): Promise<DemoSeedResult> {
  const owner = await prisma.user.upsert({
    where: { email: DEMO.OWNER_EMAIL },
    update: {},
    create: { email: DEMO.OWNER_EMAIL, name: "Fade District (Demo)" },
  });

  // Refuse to touch a `demo`-slugged shop we don't own: the wipe below is
  // destructive, and slugs are user-claimable — never assume.
  const existing = await prisma.shop.findFirst({
    where: { slug: DEMO.SHOP_SLUG },
    select: { id: true, ownerId: true },
  });
  if (existing && existing.ownerId !== owner.id) {
    throw new Error(
      `Shop slug "${DEMO.SHOP_SLUG}" belongs to another owner (${existing.ownerId}) — refusing to reseed it.`,
    );
  }

  const shopData = {
    name: "Fade District",
    slug: DEMO.SHOP_SLUG,
    timezone: TZ,
    bookingMode: "native" as const,
    // Root-relative so the rewards page's "Book your next cut" CTA + rebook
    // countdown link to the native picker on every environment. The /s page
    // ignores bookingUrl in native mode, and no SMS ever renders it (all text
    // toggles are off), so the relative form is safe here.
    bookingUrl: `/book/${DEMO.SHOP_SLUG}`,
    industry: "barber",
    // compAccess = full Premium without Stripe, so booking never 402s and the
    // demo is excluded from paying-revenue counts.
    compAccess: true,
    publicPageEnabled: true,
    theme: "midnight",
    fontKey: "bold",
    layoutStyle: "soft",
    // Explicit (matches the midnight theme's accent) so the /book page — which
    // reads accentColor only, not the theme — renders in the same blue instead
    // of falling back to the default gold.
    accentColor: "#5B8CFF",
    bio: "Precision fades and sharp lineups. Book online — your chair is waiting.",
    hoursText: "Mon–Fri 10am–6pm\nSat 10am–6pm\nSun closed",
    instagramHandle: "fadedistrict",
    heroImageUrl: "/demo/hero.svg",
    galleryItems: [
      { url: "/demo/gallery-1.svg", caption: "Skin fade" },
      { url: "/demo/gallery-2.svg", caption: "Crisp lineup" },
      { url: "/demo/gallery-3.svg", caption: "Beard sculpt" },
      { url: "/demo/gallery-4.svg", caption: "The classic" },
    ],
    rewardsEnabled: true,
    rewardsWelcome: "Welcome to the District — every cut counts.",
    punchesPerVisit: 1,
    rebookWindowDays: 14,
    waitlistEnabled: true,
    payDirectEnabled: true,
    payDirectZelle: "pay@fadedistrict.com",
    payDirectVenmo: "fadedistrict",
    payDirectCashApp: "fadedistrict",
    payDirectNote: "Zelle or cash on arrival — no fees.",
    // Every outbound-text switch stays OFF: the demo must never send.
    loyaltyTextsEnabled: false,
    winbackTextsEnabled: false,
    slotOpenedTextsEnabled: false,
    takesRequests: false,
    notifyPhone: null,
    requireBookingApproval: false,
    receptionistEnabled: false,
  };

  const shop = existing
    ? await prisma.shop.update({ where: { id: existing.id }, data: shopData })
    : await prisma.shop.create({
        data: {
          ...shopData,
          ownerId: owner.id,
          webhookSecret: crypto.randomBytes(24).toString("hex"),
        },
      });

  await prisma.$transaction(
    async (tx) => {
      // Wipe every child row (FK-safe order: referencing rows before referenced),
      // then recreate the canonical set. Covers both idempotent reseeding and
      // clearing anything viewers submitted (reviews, waitlist joins, bookings).
      const w = { shopId: shop.id };
      await tx.nudge.deleteMany({ where: w });
      await tx.punchLedger.deleteMany({ where: w });
      await tx.appointment.deleteMany({ where: w });
      await tx.recurringSeries.deleteMany({ where: w });
      await tx.visit.deleteMany({ where: w });
      await tx.targetedSlot.deleteMany({ where: w });
      await tx.reward.deleteMany({ where: w });
      await tx.cardGrant.deleteMany({ where: w });
      await tx.cardType.deleteMany({ where: w });
      await tx.earnRule.deleteMany({ where: w });
      await tx.promotion.deleteMany({ where: w }); // redemptions cascade
      await tx.review.deleteMany({ where: w });
      await tx.waitlistEntry.deleteMany({ where: w });
      await tx.appointmentRequest.deleteMany({ where: w });
      await tx.pushSubscription.deleteMany({ where: w });
      await tx.walletPassRegistration.deleteMany({ where: w });
      await tx.receptionistConversation.deleteMany({ where: w }); // messages cascade
      await tx.serviceStaff.deleteMany({ where: w });
      await tx.availabilityRule.deleteMany({ where: w });
      await tx.availabilityException.deleteMany({ where: w });
      await tx.serviceAddOn.deleteMany({ where: w });
      await tx.service.deleteMany({ where: w });
      await tx.staff.deleteMany({ where: w });
      await tx.client.deleteMany({ where: w });

      // --- Staff + services + hours ---
      const marcus = await tx.staff.create({
        data: { shopId: shop.id, name: "Marcus", bio: "Owner. 12 years behind the chair.", sortOrder: 0 },
      });
      const dre = await tx.staff.create({
        data: { shopId: shop.id, name: "Dre", bio: "Fades, designs, and beard work.", sortOrder: 1 },
      });

      const haircut = await tx.service.create({
        data: {
          shopId: shop.id,
          name: "Haircut",
          description: "Fade, taper, or scissor cut — finished clean.",
          durationMin: 30,
          price: 35,
          priceOverrides: { "6": 45 }, // Saturday premium
          durationOverrides: { "5": 25 }, // faster Friday pace
          sortOrder: 0,
        },
      });
      const beard = await tx.service.create({
        data: { shopId: shop.id, name: "Beard Trim", durationMin: 15, price: 20, sortOrder: 1 },
      });
      const combo = await tx.service.create({
        data: { shopId: shop.id, name: "Haircut + Beard", durationMin: 45, price: 50, sortOrder: 2 },
      });

      for (const service of [haircut, beard, combo]) {
        for (const staff of [marcus, dre]) {
          await tx.serviceStaff.create({
            data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
          });
        }
      }
      // Mon–Sat 10:00–18:00 local, both chairs.
      for (const staff of [marcus, dre]) {
        for (let weekday = 1; weekday <= 6; weekday++) {
          await tx.availabilityRule.create({
            data: { shopId: shop.id, staffId: staff.id, weekday, startMin: 600, endMin: 1080 },
          });
        }
      }

      await tx.serviceAddOn.create({
        data: { shopId: shop.id, name: "Hot Towel Finish", durationMin: 5, price: 10, sortOrder: 0 },
      });
      await tx.serviceAddOn.create({
        data: { shopId: shop.id, name: "Precision Line-Up", durationMin: 5, price: 8, sortOrder: 1 },
      });

      // Targeted "special" slots at 8pm (outside normal hours — that's the
      // point) on the next three evenings, so whichever near day a tour viewer
      // lands on shows the badge.
      for (let d = 1; d <= 3; d++) {
        await tx.targetedSlot.create({
          data: {
            shopId: shop.id,
            staffId: marcus.id,
            serviceId: haircut.id,
            label: "Late-night special",
            startsAt: localTime(d, 20 * 60),
            durationMin: 30,
            price: 25,
          },
        });
      }

      // --- Loyalty: default-card rewards + an exclusive VIP card ---
      const vip = await tx.cardType.create({
        data: {
          shopId: shop.id,
          name: "VIP",
          description: "Invite-only — for the regulars.",
          emoji: "👑",
          accentColor: "#D4AF37",
          exclusive: true,
          punchesPerVisit: 1,
          sortOrder: 0,
        },
      });
      await tx.reward.create({
        data: { shopId: shop.id, name: "Free Cut", description: "Ten punches, on the house.", emoji: "✂️", punchCost: 10, sortOrder: 0 },
      });
      await tx.reward.create({
        data: { shopId: shop.id, name: "Free Beard Trim", emoji: "🧔", punchCost: 6, sortOrder: 1 },
      });
      await tx.reward.create({
        data: {
          shopId: shop.id,
          name: "Priority Chair",
          description: "Skip the wait — VIP only.",
          emoji: "👑",
          punchCost: 4,
          cardTypeId: vip.id,
          sortOrder: 2,
        },
      });

      // --- The demo client: mid-progress everything ---
      // 6 completed visits, 14 days apart, last one 5 days ago → Silver tier,
      // default-card balance 6 (Free Beard Trim READY, Free Cut at 6/10), rebook
      // countdown mid-window (deadline 9 days out), never nudge-eligible.
      const lastVisitAt = localTime(-5, 11 * 60);
      const client = await tx.client.create({
        data: {
          shopId: shop.id,
          acuityClientKey: DEMO.CLIENT_PHONE,
          firstName: "Jordan",
          lastName: "D.",
          phone: DEMO.CLIENT_PHONE,
          smsConsentAt: new Date(),
          smsConsentSource: "manual",
          source: "manual",
          magicToken: DEMO.MAGIC_TOKEN,
          preferredCadence: "BIWEEKLY",
          loyaltyTier: "SILVER",
          medianIntervalDays: 14,
          lastVisitAt,
          nextExpectedAt: addDays(lastVisitAt, 14),
        },
      });
      await tx.cardGrant.create({
        data: { shopId: shop.id, cardTypeId: vip.id, clientId: client.id },
      });

      for (let i = 1; i <= 6; i++) {
        const scheduledAt = localTime(-5 - (6 - i) * 14, 11 * 60);
        const serviceName = i % 3 === 0 ? "Haircut + Beard" : "Haircut";
        const visit = await tx.visit.create({
          data: {
            shopId: shop.id,
            clientId: client.id,
            acuityAppointmentId: `demo:visit:${i}`,
            status: "COMPLETED",
            scheduledAt,
            endAt: new Date(scheduledAt.getTime() + 30 * 60_000),
            completedAt: new Date(scheduledAt.getTime() + 30 * 60_000),
            price: serviceName === "Haircut" ? 35 : 50,
            serviceName,
          },
        });
        await tx.punchLedger.create({
          data: {
            shopId: shop.id,
            clientId: client.id,
            visitId: visit.id,
            punchesEarned: 1,
            runningBalance: i,
            createdAt: visit.endAt!,
          },
        });
      }
      // Two VIP-card punches (barber-granted, not tied to a visit).
      for (let i = 1; i <= 2; i++) {
        await tx.punchLedger.create({
          data: {
            shopId: shop.id,
            clientId: client.id,
            cardTypeId: vip.id,
            punchesEarned: 1,
            runningBalance: i,
            note: "VIP appreciation",
            createdAt: localTime(-5 - (2 - i) * 28, 12 * 60),
          },
        });
      }

      // --- Social proof + a live promotion ---
      const reviews: [number, string, string, number][] = [
        [5, "Marcus is the truth. Cleanest fade in the city, every single time.", "Chris T.", -40],
        [5, "Booked online in 30 seconds, walked in, walked out fresh. The reminder texts are clutch.", "Devon M.", -25],
        [4, "Great with my son. We're every-two-weeks regulars now.", "Alicia R.", -12],
        [5, "The punch card hit different when the tenth cut was free.", "Marquis W.", -6],
      ];
      for (const [rating, body, authorName, daysAgo] of reviews) {
        await tx.review.create({
          data: {
            shopId: shop.id,
            rating,
            body,
            authorName,
            status: "APPROVED",
            createdAt: localTime(daysAgo, 15 * 60),
          },
        });
      }
      await tx.promotion.create({
        data: {
          shopId: shop.id,
          kind: "PERCENT_OFF",
          title: "Summer Special",
          description: "20% off any weekday cut",
          code: "SUMMER20",
          percentOff: 20,
          startsAt: localTime(-1, 0),
          endsAt: localTime(10, 23 * 60),
        },
      });

      // --- The showcase appointment: tomorrow 11:00, fixed manage token ---
      // Drives the /book/manage step (check-in + summary). Every send-stamp is
      // pre-set so the reminder/confirmation engines never touch it.
      const startsAt = localTime(1, 11 * 60);
      const stamped = new Date();
      await tx.appointment.create({
        data: {
          shopId: shop.id,
          staffId: marcus.id,
          serviceId: haircut.id,
          clientId: client.id,
          firstName: "Jordan",
          lastName: "D.",
          phone: DEMO.CLIENT_PHONE,
          status: "BOOKED",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 35 * 60_000),
          priceAtBooking: 45,
          addOns: [{ name: "Hot Towel Finish", durationMin: 5, price: 10 }],
          manageToken: DEMO.MANAGE_TOKEN,
          confirmationSentAt: stamped,
          reminderSentAt: stamped,
          confirmationEmailSentAt: stamped,
          reminderEmailSentAt: stamped,
          reminder24hPushSentAt: stamped,
          reminder2hPushSentAt: stamped,
        },
      });
    },
    { timeout: 60_000 },
  );

  return {
    shopId: shop.id,
    slug: DEMO.SHOP_SLUG,
    clientMagicToken: DEMO.MAGIC_TOKEN,
    appointmentManageToken: DEMO.MANAGE_TOKEN,
  };
}
