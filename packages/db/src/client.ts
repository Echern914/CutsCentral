import { PrismaClient } from "./generated/client/index.js";

/**
 * Singleton Prisma client. In dev, Next/tsx hot-reload can instantiate many
 * clients and exhaust the connection pool, so we stash one on globalThis.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
