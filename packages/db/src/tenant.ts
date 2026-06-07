import { prisma } from "./client.js";
import { Prisma } from "./generated/client/index.js";

/**
 * Tenant-scoping seam + RLS context.
 *
 * `forShop(shopId)` returns pre-scoped accessors. Two layers of protection:
 *  1. APP LAYER: shopId is merged into every `where` and stamped into every
 *     `create`, so a caller cannot run a tenant query without it.
 *  2. DB LAYER (defense-in-depth): each operation runs inside a transaction that
 *     first sets `app.current_shop_id`; Postgres RLS policies then restrict rows
 *     to that shop. Even an app-layer bug or a leaked app credential cannot cross
 *     tenants. (Requires the app to connect as the non-owner RLS role — see the
 *     RLS migration. With the owner role, layer 1 still fully applies.)
 *
 * The set_config is transaction-local (`true`), which is required for Supabase's
 * PgBouncer transaction pooling — a plain SESSION SET would not survive pooling.
 *
 * THE RULE: tenant tables (Client, Visit, PunchLedger, Nudge) are ONLY touched
 * through forShop(). Direct prisma.* is reserved for non-tenant tables (User,
 * Shop, AcuityConnection) and the single global magicToken lookup.
 */

/**
 * When true, each tenant transaction does `SET LOCAL ROLE chairback_app` so RLS
 * is actually enforced even though the underlying connection is the DB owner
 * (the owner otherwise bypasses RLS). Enabled once the RLS migration has run.
 * Toggle via DB_RLS_ENFORCE=false to fall back to app-layer-only (e.g. if the
 * role isn't present yet).
 */
const ENFORCE_RLS = process.env.DB_RLS_ENFORCE !== "false";

/** Run a unit of work inside a transaction with the RLS shop context set. */
export async function runWithShop<T>(
  shopId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // SET LOCAL role so RLS applies to this transaction (owner bypasses RLS).
    if (ENFORCE_RLS) {
      await tx.$executeRawUnsafe("SET LOCAL ROLE chairback_app");
    }
    // Transaction-local setting (survives PgBouncer transaction pooling).
    await tx.$executeRaw`SELECT set_config('app.current_shop_id', ${shopId}, true)`;
    return fn(tx);
  });
}

function stamp<T>(data: T, shopId: string): T {
  return { ...data, shopId } as T;
}

function scopeWhere<W extends object | undefined>(
  where: W,
  shopId: string,
): W & { shopId: string } {
  return { ...(where ?? {}), shopId } as W & { shopId: string };
}

type ClientCreateNoShop = Omit<Prisma.ClientUncheckedCreateInput, "shopId">;
type VisitCreateNoShop = Omit<Prisma.VisitUncheckedCreateInput, "shopId">;
type PunchCreateNoShop = Omit<Prisma.PunchLedgerUncheckedCreateInput, "shopId">;
type NudgeCreateNoShop = Omit<Prisma.NudgeUncheckedCreateInput, "shopId">;

export function forShop(shopId: string) {
  return {
    shopId,

    client: {
      findMany: (args: Prisma.ClientFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.client.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.ClientFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.client.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.ClientCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.client.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      upsert: (args: {
        where: Prisma.ClientWhereUniqueInput;
        create: ClientCreateNoShop;
        update: Prisma.ClientUpdateInput;
        select?: Prisma.ClientSelect;
        include?: Prisma.ClientInclude;
      }) =>
        runWithShop(shopId, (tx) =>
          tx.client.upsert({
            ...args,
            create: stamp(args.create, shopId) as Prisma.ClientUncheckedCreateInput,
          }),
        ),
      update: (args: Prisma.ClientUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.client.update({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    visit: {
      findMany: (args: Prisma.VisitFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.visit.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.VisitFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.visit.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.VisitCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.visit.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      upsert: (args: {
        where: Prisma.VisitWhereUniqueInput;
        create: VisitCreateNoShop;
        update: Prisma.VisitUpdateInput;
        select?: Prisma.VisitSelect;
        include?: Prisma.VisitInclude;
      }) =>
        runWithShop(shopId, (tx) =>
          tx.visit.upsert({
            ...args,
            create: stamp(args.create, shopId) as Prisma.VisitUncheckedCreateInput,
          }),
        ),
      update: (args: Prisma.VisitUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.visit.update({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      updateMany: (args: Prisma.VisitUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.visit.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    punch: {
      findMany: (args: Prisma.PunchLedgerFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.punchLedger.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.PunchLedgerFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.punchLedger.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.PunchLedgerCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.punchLedger.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: PunchCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.punchLedger.create({
            data: stamp(args.data, shopId) as Prisma.PunchLedgerUncheckedCreateInput,
          }),
        ),
      upsert: (args: {
        where: Prisma.PunchLedgerWhereUniqueInput;
        create: PunchCreateNoShop;
        update: Prisma.PunchLedgerUpdateInput;
      }) =>
        runWithShop(shopId, (tx) =>
          tx.punchLedger.upsert({
            ...args,
            create: stamp(args.create, shopId) as Prisma.PunchLedgerUncheckedCreateInput,
          }),
        ),
    },

    nudge: {
      findMany: (args: Prisma.NudgeFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.nudge.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.NudgeFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.nudge.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.NudgeCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.nudge.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: NudgeCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.nudge.create({
            data: stamp(args.data, shopId) as Prisma.NudgeUncheckedCreateInput,
          }),
        ),
      update: (args: Prisma.NudgeUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.nudge.update({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },
  };
}

export type ShopScope = ReturnType<typeof forShop>;
