/** One-shot: verify the first real Acuity connection + clean up debug account. */
import { prisma } from "../src/client.js";

async function main() {
  const shopId = "cmq3ybnc1000213t45xm6g06a";
  const [shop, conn, clients, visits] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { name: true, acuityWebhookIds: true },
    }),
    prisma.acuityConnection.findUnique({
      where: { shopId },
      select: {
        acuityAccountId: true,
        scope: true,
        tokenExpiresAt: true,
        refreshToken: true,
        connectedAt: true,
      },
    }),
    prisma.client.count({ where: { shopId } }),
    prisma.visit.count({ where: { shopId } }),
  ]);

  console.log("shop:", shop?.name);
  console.log("connection:", conn ? "EXISTS" : "MISSING");
  if (conn) {
    console.log("  acuityAccountId:", conn.acuityAccountId);
    console.log("  scope:", conn.scope);
    console.log("  connectedAt:", conn.connectedAt.toISOString());
    console.log("  tokenExpiresAt:", conn.tokenExpiresAt?.toISOString() ?? "null (no expiry => no refresh dance)");
    console.log("  refreshToken:", conn.refreshToken ? "present (encrypted)" : "absent");
  }
  console.log("webhookIds stored:", shop?.acuityWebhookIds.length ?? 0, shop?.acuityWebhookIds ?? []);
  console.log("clients:", clients, "visits:", visits);

  // Remove the throwaway debug account created while diagnosing the OAuth env.
  const dbg = await prisma.user.findUnique({ where: { email: "cbdebug-vrnekqau@test.local" } });
  if (dbg) {
    await prisma.shop.deleteMany({ where: { ownerId: dbg.id } });
    await prisma.user.delete({ where: { id: dbg.id } });
    console.log("debug account removed");
  } else {
    console.log("debug account: not found (already gone)");
  }
}

main().finally(() => prisma.$disconnect());
