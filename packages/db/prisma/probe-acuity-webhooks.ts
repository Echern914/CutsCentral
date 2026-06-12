/**
 * One-shot probe: discover Acuity's real Dynamic Webhooks API shape using the
 * live connection's token (decrypted locally; never printed).
 */
import { decrypt } from "@chairback/config";
import { prisma } from "../src/client.js";

const PROD_KEY = process.env.PROD_TOKEN_ENCRYPTION_KEY!;
const API = "https://acuityscheduling.com/api/v1";

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log(`${method} ${path} -> ${res.status}`);
  console.log(`  body: ${text.slice(0, 500)}`);
  return { status: res.status, text };
}

async function main() {
  const conn = await prisma.acuityConnection.findUnique({
    where: { shopId: "cmq3ybnc1000213t45xm6g06a" },
    select: { accessToken: true },
  });
  if (!conn) throw new Error("no connection");
  const token = decrypt(conn.accessToken, PROD_KEY);

  // Sanity: the token works at all.
  await call("GET", "/me", token);
  // Discover: list current webhook subscriptions.
  await call("GET", "/webhooks", token);
  // Try creating one (scheduled) against the prod target.
  await call("POST", "/webhooks", token, {
    event: "scheduled",
    target:
      "https://api.getchairback.com/webhooks/acuity/PROBE-PLACEHOLDER-will-delete",
  });
  // List again to see what (if anything) was created.
  await call("GET", "/webhooks", token);
}

main().finally(() => prisma.$disconnect());
