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
 *     tenants. (Requires the app to connect as the non-owner RLS role - see the
 *     RLS migration. With the owner role, layer 1 still fully applies.)
 *
 * The set_config is transaction-local (`true`), which is required for Supabase's
 * PgBouncer transaction pooling - a plain SESSION SET would not survive pooling.
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
// Accept both documented falsy spellings ("false"/"0") - the env schema allows
// either, and treating "0" as enabled would SET ROLE to a possibly-absent role
// and take down every tenant query.
const ENFORCE_RLS = !["false", "0"].includes(
  (process.env.DB_RLS_ENFORCE ?? "").trim(),
);

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

/**
 * Run a unit of work that must read/write a GLOBALLY-unique row with NO shop
 * context - the public-by-magicToken endpoints (rewards view, SMS opt-in/out,
 * push subscribe, resolve-by-phone). These resolve a Client by its global token
 * BEFORE any shop is known, so they cannot use forShop().
 *
 * The catch: the tenant tables are FORCE ROW LEVEL SECURITY, and FORCE means even
 * the table OWNER is subject to the policy. With no `app.current_shop_id` set, the
 * policy `shopId = current_shop_id()` matches ZERO rows - so a plain owner query
 * silently returns nothing (every magicToken 404s). We connect as the owner, so
 * the sanctioned escape is `SET LOCAL row_security = off` (owner-only, scoped to
 * this transaction). This restores the documented "magicToken resolves without a
 * shop" behavior WITHOUT weakening tenant isolation anywhere else: forShop() still
 * SET ROLEs to the non-owner app role where row_security can't be turned off.
 *
 * Use ONLY for genuinely global, unguessable-key lookups - never for a query that
 * should be shop-scoped.
 */
export async function runAsOwner<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Owner + row_security off => FORCE RLS does not filter this transaction.
    // Transaction-scoped (LOCAL), so it never leaks to other connections/queries.
    await tx.$executeRawUnsafe("SET LOCAL row_security = off");
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
type RewardCreateNoShop = Omit<Prisma.RewardUncheckedCreateInput, "shopId">;
type EarnRuleCreateNoShop = Omit<Prisma.EarnRuleUncheckedCreateInput, "shopId">;
type PromotionCreateNoShop = Omit<Prisma.PromotionUncheckedCreateInput, "shopId">;
type PromoUseCreateNoShop = Omit<
  Prisma.PromotionRedemptionUncheckedCreateInput,
  "shopId"
>;
type PushSubscriptionCreateNoShop = Omit<
  Prisma.PushSubscriptionUncheckedCreateInput,
  "shopId"
>;
type StaffCreateNoShop = Omit<Prisma.StaffUncheckedCreateInput, "shopId">;
type ServiceCreateNoShop = Omit<Prisma.ServiceUncheckedCreateInput, "shopId">;
type ServiceStaffCreateNoShop = Omit<
  Prisma.ServiceStaffUncheckedCreateInput,
  "shopId"
>;
type AvailabilityRuleCreateNoShop = Omit<
  Prisma.AvailabilityRuleUncheckedCreateInput,
  "shopId"
>;
type AvailabilityExceptionCreateNoShop = Omit<
  Prisma.AvailabilityExceptionUncheckedCreateInput,
  "shopId"
>;

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

    reward: {
      findMany: (args: Prisma.RewardFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.reward.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.RewardFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.reward.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.RewardCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.reward.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: RewardCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.reward.create({
            data: stamp(args.data, shopId) as Prisma.RewardUncheckedCreateInput,
          }),
        ),
      update: (args: Prisma.RewardUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.reward.update({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      // updateMany keys the where by non-unique fields, which lets a delete-safe
      // "update if mine" pattern work without a prior fetch.
      updateMany: (args: Prisma.RewardUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.reward.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      deleteMany: (args: Prisma.RewardDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.reward.deleteMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    earnRule: {
      findMany: (args: Prisma.EarnRuleFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.EarnRuleFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.EarnRuleCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: EarnRuleCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.create({
            data: stamp(args.data, shopId) as Prisma.EarnRuleUncheckedCreateInput,
          }),
        ),
      updateMany: (args: Prisma.EarnRuleUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      deleteMany: (args: Prisma.EarnRuleDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.earnRule.deleteMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    promotion: {
      findMany: (args: Prisma.PromotionFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.PromotionFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.PromotionCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: PromotionCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.create({
            data: stamp(args.data, shopId) as Prisma.PromotionUncheckedCreateInput,
          }),
        ),
      updateMany: (args: Prisma.PromotionUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      deleteMany: (args: Prisma.PromotionDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.promotion.deleteMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    promoUse: {
      findMany: (args: Prisma.PromotionRedemptionFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.promotionRedemption.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      count: (args: Prisma.PromotionRedemptionCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.promotionRedemption.count({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      create: (args: { data: PromoUseCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.promotionRedemption.create({
            data: stamp(
              args.data,
              shopId,
            ) as Prisma.PromotionRedemptionUncheckedCreateInput,
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

    // Web Push subscriptions. No create here on purpose: the subscribe insert
    // happens on the PUBLIC rewards route (resolved by magicToken, no shop
    // context) via plain prisma. The send path reads them here (RLS), bumps
    // lastSeenAt/failureCount on send, and prunes dead ones via deleteMany.
    pushSubscription: {
      findMany: (args: Prisma.PushSubscriptionFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.pushSubscription.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      count: (args: Prisma.PushSubscriptionCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.pushSubscription.count({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      create: (args: { data: PushSubscriptionCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.pushSubscription.create({
            data: stamp(
              args.data,
              shopId,
            ) as Prisma.PushSubscriptionUncheckedCreateInput,
          }),
        ),
      updateMany: (args: Prisma.PushSubscriptionUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.pushSubscription.updateMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      deleteMany: (args: Prisma.PushSubscriptionDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.pushSubscription.deleteMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },

    // Leads from the public page form. No create here on purpose: the insert
    // happens on the UNauthenticated public route (no shop context), via plain
    // prisma. The barber only reads/updates them through this scoped accessor.
    appointmentRequest: {
      findMany: (args: Prisma.AppointmentRequestFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointmentRequest.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      findFirst: (args: Prisma.AppointmentRequestFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointmentRequest.findFirst({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      count: (args: Prisma.AppointmentRequestCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointmentRequest.count({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      update: (args: Prisma.AppointmentRequestUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.appointmentRequest.update({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },

    // Reviews: created on the UNauthenticated public route (plain prisma, no shop
    // context), then read/moderated here through the scoped accessor (RLS).
    review: {
      findMany: (args: Prisma.ReviewFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.review.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.ReviewFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.review.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.ReviewCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.review.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      update: (args: Prisma.ReviewUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.review.update({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    //  Native booking engine (only used when shop.bookingMode == native)

    staff: {
      findMany: (args: Prisma.StaffFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.staff.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.StaffFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.staff.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.StaffCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.staff.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: StaffCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.staff.create({
            data: stamp(args.data, shopId) as Prisma.StaffUncheckedCreateInput,
          }),
        ),
      updateMany: (args: Prisma.StaffUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.staff.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    service: {
      findMany: (args: Prisma.ServiceFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.service.findMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      findFirst: (args: Prisma.ServiceFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.service.findFirst({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      count: (args: Prisma.ServiceCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.service.count({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
      create: (args: { data: ServiceCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.service.create({
            data: stamp(args.data, shopId) as Prisma.ServiceUncheckedCreateInput,
          }),
        ),
      updateMany: (args: Prisma.ServiceUpdateManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.service.updateMany({ ...args, where: scopeWhere(args.where, shopId) }),
        ),
    },

    serviceStaff: {
      findMany: (args: Prisma.ServiceStaffFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.serviceStaff.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      create: (args: { data: ServiceStaffCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.serviceStaff.create({
            data: stamp(
              args.data,
              shopId,
            ) as Prisma.ServiceStaffUncheckedCreateInput,
          }),
        ),
      deleteMany: (args: Prisma.ServiceStaffDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.serviceStaff.deleteMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },

    availabilityRule: {
      findMany: (args: Prisma.AvailabilityRuleFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityRule.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      create: (args: { data: AvailabilityRuleCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityRule.create({
            data: stamp(
              args.data,
              shopId,
            ) as Prisma.AvailabilityRuleUncheckedCreateInput,
          }),
        ),
      deleteMany: (args: Prisma.AvailabilityRuleDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityRule.deleteMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },

    availabilityException: {
      findMany: (args: Prisma.AvailabilityExceptionFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityException.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      create: (args: { data: AvailabilityExceptionCreateNoShop }) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityException.create({
            data: stamp(
              args.data,
              shopId,
            ) as Prisma.AvailabilityExceptionUncheckedCreateInput,
          }),
        ),
      deleteMany: (args: Prisma.AvailabilityExceptionDeleteManyArgs) =>
        runWithShop(shopId, (tx) =>
          tx.availabilityException.deleteMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },

    // Native appointments. No create here on purpose: the public booking insert
    // runs on the UNauthenticated route (no shop context) via plain prisma in a
    // single transaction (the same trust model as appointmentRequest/review).
    // The barber reads/cancels/completes through this scoped accessor (RLS).
    appointment: {
      findMany: (args: Prisma.AppointmentFindManyArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointment.findMany({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      findFirst: (args: Prisma.AppointmentFindFirstArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointment.findFirst({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      count: (args: Prisma.AppointmentCountArgs = {}) =>
        runWithShop(shopId, (tx) =>
          tx.appointment.count({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
      update: (args: Prisma.AppointmentUpdateArgs) =>
        runWithShop(shopId, (tx) =>
          tx.appointment.update({
            ...args,
            where: scopeWhere(args.where, shopId),
          }),
        ),
    },
  };
}

export type ShopScope = ReturnType<typeof forShop>;
