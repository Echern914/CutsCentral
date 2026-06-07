import "./env-bootstrap.js"; // MUST be first - loads .env before anything reads env
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";

const env = apiEnv();
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

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
