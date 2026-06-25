export { prisma } from "./client.js";
export { forShop, runWithShop, runAsOwner } from "./tenant.js";
export type { ShopScope } from "./tenant.js";

// Re-export the generated Prisma namespace, enums, and model types so apps
// import everything DB-related from "@chairback/db".
export * from "./generated/client/index.js";
