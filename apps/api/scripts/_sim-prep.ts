import "../src/env-bootstrap.js";
import crypto from "node:crypto";
import { prisma } from "@chairback/db";

// One-off DEV seeder for the receptionist simulator: a fully configured
// native-mode shop that passes every receptionist gate, plus a known client
// for the shared-number routing. Idempotent (keyed on the shop slug).
const PROD_REF = "czqjnhwxcubnskyfamvb";
const SLUG = "sim-barbershop";
const PHONE = "+15555550100";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes(PROD_REF)) {
    console.error("Refusing to run against PROD.");
    process.exit(1);
  }

  const owner = await prisma.user.upsert({
    where: { email: "sim-owner@chairback.dev" },
    update: {},
    create: { email: "sim-owner@chairback.dev", name: "Sim Owner" },
  });

  let shop = await prisma.shop.findFirst({ where: { slug: SLUG } });
  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        ownerId: owner.id,
        name: "Sim Barbershop",
        slug: SLUG,
        timezone: "America/New_York",
        bookingMode: "native",
        receptionistEnabled: true,
        receptionistCompAccess: true,
        receptionistTermsAcceptedAt: new Date(),
        webhookSecret: crypto.randomBytes(24).toString("hex"),
      },
    });
    console.log(`Created shop ${shop.id} (${SLUG})`);
  } else {
    shop = await prisma.shop.update({
      where: { id: shop.id },
      data: {
        bookingMode: "native",
        receptionistEnabled: true,
        receptionistCompAccess: true,
        receptionistTermsAcceptedAt: shop.receptionistTermsAcceptedAt ?? new Date(),
      },
    });
    console.log(`Updated shop ${shop.id} (${SLUG})`);
  }

  const staffCount = await prisma.staff.count({ where: { shopId: shop.id } });
  if (staffCount === 0) {
    const drick = await prisma.staff.create({
      data: { shopId: shop.id, name: "Drick", sortOrder: 0 },
    });
    const tony = await prisma.staff.create({
      data: { shopId: shop.id, name: "Tony", sortOrder: 1 },
    });
    const services = await Promise.all(
      [
        { name: "Haircut", durationMin: 30, price: 35 },
        { name: "Beard Trim", durationMin: 15, price: 20 },
        { name: "Haircut + Beard", durationMin: 45, price: 50 },
      ].map((s, i) =>
        prisma.service.create({
          data: { shopId: shop.id, sortOrder: i, ...s },
        }),
      ),
    );
    for (const service of services) {
      for (const staff of [drick, tony]) {
        await prisma.serviceStaff.create({
          data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
        });
      }
    }
    // Mon-Sat 10:00-18:00 local for both barbers
    for (const staff of [drick, tony]) {
      for (let weekday = 1; weekday <= 6; weekday++) {
        await prisma.availabilityRule.create({
          data: { shopId: shop.id, staffId: staff.id, weekday, startMin: 600, endMin: 1080 },
        });
      }
    }
    console.log("Seeded 2 staff, 3 services, Mon-Sat 10-6 availability");
  } else {
    console.log(`Staff already seeded (${staffCount})`);
  }

  const client = await prisma.client.findFirst({
    where: { shopId: shop.id, phone: PHONE },
  });
  if (!client) {
    await prisma.client.create({
      data: {
        shopId: shop.id,
        acuityClientKey: PHONE,
        firstName: "Eric",
        lastName: "Sim",
        phone: PHONE,
        smsConsentAt: new Date(),
        smsConsentSource: "manual",
        source: "manual",
        magicToken: crypto.randomUUID(),
      },
    });
    console.log(`Created client Eric Sim (${PHONE})`);
  } else {
    console.log(`Client already exists (${PHONE})`);
  }

  console.log("\nReady. Run:");
  console.log(
    `  pnpm --filter @chairback/api exec tsx scripts/receptionist-sim.ts --shop ${SLUG} --phone ${PHONE}`,
  );
  await prisma.$disconnect();
}

void main();
