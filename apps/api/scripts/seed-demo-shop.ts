import "../src/env-bootstrap.js";
import { prisma } from "@chairback/db";
import { seedDemoShop } from "../src/demo/seedDemoShop.js";

// Seed (or restore to canonical) the live-demo tenant "Fade District". Safe to
// re-run any time — it wipes and recreates the demo shop's children. Prod is
// refused unless --allow-prod is passed explicitly: seeding prod is a
// deliberate, one-time launch step (see the PR/deploy notes), never an accident.
const PROD_REF = "czqjnhwxcubnskyfamvb";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes(PROD_REF) && !process.argv.includes("--allow-prod")) {
    console.error("DATABASE_URL points at PROD. Re-run with --allow-prod if you really mean it.");
    process.exit(1);
  }

  const result = await seedDemoShop();
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  console.log(`Demo shop ready (${result.shopId}). Tour surfaces:`);
  console.log(`  Mini-site:   ${base}/s/${result.slug}`);
  console.log(`  Booking:     ${base}/book/${result.slug}`);
  console.log(`  Manage:      ${base}/book/manage/${result.appointmentManageToken}`);
  console.log(`  Rewards:     ${base}/r/${result.clientMagicToken}`);
  console.log(`  Guided tour: ${base}/demo`);
  await prisma.$disconnect();
}

void main();
