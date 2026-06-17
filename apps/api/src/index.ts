import "./env-bootstrap.js"; // MUST be first - loads .env before anything reads env
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";
import { captureError, initSentry } from "./sentry.js";

const env = apiEnv();
initSentry();
warnOnUndersizedPool(env.DATABASE_URL);
// Hosts (Railway, Render, etc.) inject PORT and route traffic to it. Prefer that;
// fall back to the API_BASE_URL port, then 4000 for local dev.
const PORT = Number(
  process.env.PORT || new URL(env.API_BASE_URL).port || 4000,
);

const app = createApp();

// Bind to 0.0.0.0 so the container is reachable from outside (not just localhost).
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "chairback-api listening");
});

startScheduler();

/**
 * Boot-time scalability guard. The API is one long-lived process and every
 * tenant query runs inside a transaction (runWithShop), so the Prisma client
 * pool size (`connection_limit` on the pooled DATABASE_URL) is the hard ceiling
 * on concurrent requests. `connection_limit=1` is the *serverless* recipe and
 * silently serializes the whole API here - it won't error, requests just queue.
 * The fix is config (raise connection_limit in Railway), so surface a loud log
 * line at boot instead of letting it stall invisibly under load. Production-only
 * so local dev with connection_limit=1 stays quiet.
 */
function warnOnUndersizedPool(databaseUrl: string): void {
  if (env.NODE_ENV !== "production") return;
  let limit: number | null = null;
  try {
    const raw = new URL(databaseUrl).searchParams.get("connection_limit");
    limit = raw === null ? null : Number(raw);
  } catch {
    return; // unparseable URL would already have failed env validation
  }
  // null = Prisma's own default (num_cpus*2+1), which is fine. Only a tiny
  // explicit cap is the footgun.
  if (limit !== null && Number.isFinite(limit) && limit <= 2) {
    logger.warn(
      { connectionLimit: limit },
      "DATABASE_URL connection_limit is very low for a long-lived server - " +
        "concurrent requests will serialize behind the pool. Raise it (~10) on " +
        "the pooled DATABASE_URL in production. See .env.example sizing note.",
    );
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Safety net for fire-and-forget rejections (scheduler ticks, webhook post-ack
// work). Log instead of letting Node 20's default kill the process.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
  captureError(reason);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  captureError(err);
  process.exit(1);
});
