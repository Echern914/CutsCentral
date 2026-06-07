/**
 * Dev seed: creates a barber account + Drick's test shop so the engines can be
 * exercised immediately. Fully self-serve signup still works for everyone else;
 * this is just a shortcut for local development.
 *
 * If DEV_SEED_ACUITY_ACCESS_TOKEN is set, it also writes an (encrypted)
 * AcuityConnection so the Acuity client can hit a live account without an OAuth
 * round-trip. Otherwise the shop is created unconnected (connect via the UI).
 *
 * Idempotent: re-running upserts the same rows.
 */
import { hash } from "argon2";
import { encrypt, randomToken } from "@chairback/config";
import { prisma } from "../src/client.js";

const DEV_EMAIL = "drick@example.com";
const DEV_PASSWORD = "drick-dev-password";

async function main() {
  const encKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encKey) throw new Error("TOKEN_ENCRYPTION_KEY is required to seed");

  const passwordHash = await hash(DEV_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: DEV_EMAIL },
    update: {},
    create: { email: DEV_EMAIL, passwordHash, name: "Drick" },
  });

  // One shop per barber for now; find-or-create by owner.
  let shop = await prisma.shop.findFirst({ where: { ownerId: user.id } });
  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: "Drick's Barbershop",
        timezone: "America/New_York",
        bookingUrl: "https://drick.as.me",
        webhookSecret: randomToken(),
      },
    });
  }

  const devToken = process.env.DEV_SEED_ACUITY_ACCESS_TOKEN;
  const devAccountId = process.env.DEV_SEED_ACUITY_ACCOUNT_ID;
  if (devToken && devAccountId) {
    await prisma.acuityConnection.upsert({
      where: { shopId: shop.id },
      update: {
        accessToken: encrypt(devToken, encKey),
        acuityAccountId: devAccountId,
      },
      create: {
        shopId: shop.id,
        acuityAccountId: devAccountId,
        accessToken: encrypt(devToken, encKey),
      },
    });
    console.log("Seeded shop WITH a dev Acuity connection.");
  } else {
    console.log("Seeded shop (no Acuity connection - connect via the UI).");
  }

  console.log(`Seed complete:
  user:  ${DEV_EMAIL} / ${DEV_PASSWORD}
  shop:  ${shop.name} (${shop.id})
  webhook: /webhooks/acuity/${shop.webhookSecret}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
