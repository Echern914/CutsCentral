import "./env-bootstrap.js"; // MUST be first - loads .env before anything reads env
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";

const env = apiEnv();
const PORT = Number(new URL(env.API_BASE_URL).port || 4000);

const app = createApp();

const server = app.listen(PORT, () => {
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
