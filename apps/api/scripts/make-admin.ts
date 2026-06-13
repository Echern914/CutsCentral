import "../src/env-bootstrap.js";
import { prisma } from "@chairback/db";

/**
 * Promote a user to platform admin (grants the /admin operator portal). There is
 * deliberately NO self-serve path to isAdmin, so this CLI is how the first admin
 * is created.
 *
 * Usage (from repo root, env loaded):
 *   pnpm --filter @chairback/api admin:make you@example.com
 *   pnpm --filter @chairback/api admin:make you@example.com --revoke
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!email) {
    console.error("Usage: admin:make <email> [--revoke]");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}. Sign up first, then re-run.`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { isAdmin: !revoke },
  });
  console.log(`${revoke ? "Revoked admin from" : "Granted admin to"} ${email}.`);
  await prisma.$disconnect();
}

void main();
