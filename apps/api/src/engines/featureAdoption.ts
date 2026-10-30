import { Prisma, runAsOwner } from "@chairback/db";
import {
  ADOPTION_EXCLUDED_OWNER_DOMAINS,
  ADOPTION_EXCLUDED_OWNER_EMAILS,
  ADOPTION_FEATURES,
  DEMO,
  FEATURE_ADOPTION,
  adoptionPopulationVisible,
  roundAdoptionPct,
  type FeatureAdoptionId,
} from "@chairback/config";
import { logger } from "../logger.js";
import { DAY_MS } from "./insightsWindow.js";

/**
 * Platform-wide feature adoption: what share of real, active shops use each
 * feature in ADOPTION_FEATURES (@chairback/config/featureAdoption).
 *
 * TOTALS ONLY. The aggregate query returns one row of counts, the counts are
 * turned into rounded percentages HERE, and only the percentages leave this
 * module - never a count, a shop id or a per-shop row. Below the privacy
 * floor (FEATURE_ADOPTION.minPopulation) there is nothing at all: null.
 *
 * 🔑 ONE DEFINITION PER FEATURE. `featureFlagsSql` is the only place a
 * feature's signal is written, and it feeds both the platform aggregate and
 * "do YOU use this" for the viewing shop - so the two can never disagree about
 * what "uses it" means.
 *
 * The signals (every one is a column or row ChairBack already keeps):
 *   online_booking   Shop.bookingMode = native AND an Appointment created in
 *                    the active window (the shop's ChairBack booking page is
 *                    the calendar, and it is taking bookings)
 *   rewards          Shop.rewardsEnabled
 *   card_at_booking  Shop.paymentsMode <> off AND Shop.connectChargesEnabled
 *                    (pay ahead / deposit / card on file / hold, with a Stripe
 *                    account that can actually charge)
 *   client_messages  a Broadcast queued in the window (not a draft, not
 *                    failed), or a promo Nudge SENT in the window
 *   service_groups   an active ServiceGroup holding at least one active Service
 *   special_pricing  an active Service with a weekday price (priceOverrides),
 *                    a holiday price (dateOverrides) or a time-of-day window
 *                    that carries a price (timeOverrides[].price)
 *   custom_domain    Shop.customDomainVerifiedAt is set (the verified domain;
 *                    an unverified claim redirects nobody)
 *   rebook_nudges    a rebooking Nudge (kind "nudge") SENT in the window
 *   waitlist         Shop.waitlistEnabled
 *   auto_fill        Shop.autoFillEnabled
 *
 * THE POPULATION - who a percentage is "of":
 *   - not the demo tenant (its owner account, and the `demo` slug);
 *   - not a seeded or test account (ADOPTION_EXCLUDED_OWNER_EMAILS and
 *     ADOPTION_EXCLUDED_OWNER_DOMAINS);
 *   - not a deleted shop. DELETE /api/shops/me hard-deletes (the Shop row and
 *     everything under it cascade away), so a deleted shop has no row here to
 *     exclude - there is no soft-delete flag to filter on;
 *   - only a shop with a booking in the last FEATURE_ADOPTION.activeWindowDays:
 *     an Appointment or synced Visit CREATED in the window, or one whose time
 *     fell in it. A shop that signed up and walked away does not dilute the
 *     numbers for the shops that are open for business.
 *
 * 🔴 RLS. The tenant tables are FORCE ROW LEVEL SECURITY, so a cross-shop
 * read must run inside runAsOwner - a plain prisma query outside it matches
 * zero rows in production, while the test database (a superuser) would let
 * it through and every test would stay green.
 */

/** The percentages, keyed by feature. Counts never appear in this type. */
export interface AdoptionTotals {
  pct: Record<FeatureAdoptionId, number>;
}

export type FeatureUsage = Record<FeatureAdoptionId, boolean>;

/** `${d.toISOString()}::timestamp`, never a bare JS Date (the $queryRaw tz trap). */
function ts(d: Date): Prisma.Sql {
  return Prisma.sql`${d.toISOString()}::timestamp`;
}

/** One boolean column per feature, for every shop `s` in the FROM clause. */
function featureFlagsSql(since: Date): Prisma.Sql {
  const from = ts(since);
  return Prisma.sql`
    (s."bookingMode" = 'native' AND EXISTS (
      SELECT 1 FROM "Appointment" a WHERE a."shopId" = s."id" AND a."createdAt" >= ${from}
    )) AS "online_booking",
    s."rewardsEnabled" AS "rewards",
    (s."paymentsMode" <> 'off' AND s."connectChargesEnabled") AS "card_at_booking",
    (EXISTS (
      SELECT 1 FROM "Broadcast" b
      WHERE b."shopId" = s."id" AND b."queuedAt" >= ${from}
        AND b."status" IN ('QUEUED', 'SENDING', 'SENT', 'PARTIAL')
    ) OR EXISTS (
      SELECT 1 FROM "Nudge" n
      WHERE n."shopId" = s."id" AND n."kind" = 'promo' AND n."status" = 'SENT' AND n."sentAt" >= ${from}
    )) AS "client_messages",
    EXISTS (
      SELECT 1 FROM "ServiceGroup" g
      JOIN "Service" gs ON gs."serviceGroupId" = g."id" AND gs."active"
      WHERE g."shopId" = s."id" AND g."active"
    ) AS "service_groups",
    EXISTS (
      SELECT 1 FROM "Service" sv
      WHERE sv."shopId" = s."id" AND sv."active" AND (
        (jsonb_typeof(sv."priceOverrides") = 'object' AND sv."priceOverrides" <> '{}'::jsonb)
        OR (jsonb_typeof(sv."dateOverrides") = 'object' AND sv."dateOverrides" <> '{}'::jsonb)
        OR (jsonb_typeof(sv."timeOverrides") = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(sv."timeOverrides") w
          WHERE jsonb_typeof(w) = 'object' AND jsonb_typeof(w -> 'price') = 'number'
        ))
      )
    ) AS "special_pricing",
    (s."customDomainVerifiedAt" IS NOT NULL) AS "custom_domain",
    EXISTS (
      SELECT 1 FROM "Nudge" n
      WHERE n."shopId" = s."id" AND n."kind" = 'nudge' AND n."status" = 'SENT' AND n."sentAt" >= ${from}
    ) AS "rebook_nudges",
    s."waitlistEnabled" AS "waitlist",
    s."autoFillEnabled" AS "auto_fill"
  `;
}

/** The population predicate over `s` (Shop) and `u` (its owner). */
function populationSql(since: Date, now: Date): Prisma.Sql {
  const from = ts(since);
  const to = ts(now);
  const emails = ADOPTION_EXCLUDED_OWNER_EMAILS.map((e) => e.toLowerCase());
  const domains = ADOPTION_EXCLUDED_OWNER_DOMAINS.map((d) => `%@${d.toLowerCase()}`);
  return Prisma.sql`
    lower(u."email") NOT IN (${Prisma.join(emails)})
    AND NOT (lower(u."email") LIKE ANY (ARRAY[${Prisma.join(domains)}]::text[]))
    AND s."slug" IS DISTINCT FROM ${DEMO.SHOP_SLUG}
    AND (
      EXISTS (
        SELECT 1 FROM "Appointment" a
        WHERE a."shopId" = s."id"
          AND (a."createdAt" >= ${from} OR (a."startsAt" >= ${from} AND a."startsAt" <= ${to}))
      )
      OR EXISTS (
        SELECT 1 FROM "Visit" v
        WHERE v."shopId" = s."id"
          AND (v."createdAt" >= ${from} OR (v."scheduledAt" >= ${from} AND v."scheduledAt" <= ${to}))
      )
    )
  `;
}

const FEATURE_IDS = ADOPTION_FEATURES.map((f) => f.id);

export interface ComputeOptions {
  now?: Date;
  /**
   * TEST SEAM: narrow the population to these shops (still applying every
   * exclusion). The test database is shared by every suite, so a test can
   * only assert exact percentages over shops it made itself.
   */
  onlyShopIds?: readonly string[];
}

/**
 * Compute the platform totals now. Expensive-ish (one pass over every shop):
 * call it through getFeatureAdoptionTotals, which caches it, never per request.
 */
export async function computeFeatureAdoption(opts: ComputeOptions = {}): Promise<AdoptionTotals | null> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - FEATURE_ADOPTION.activeWindowDays * DAY_MS);
  if (opts.onlyShopIds && opts.onlyShopIds.length === 0) return null;
  const narrow = opts.onlyShopIds
    ? Prisma.sql`AND s."id" IN (${Prisma.join([...opts.onlyShopIds])})`
    : Prisma.empty;
  const counts = Prisma.join(
    FEATURE_IDS.map((id) => Prisma.sql`count(*) FILTER (WHERE ${Prisma.raw(`"${id}"`)})::int AS ${Prisma.raw(`"${id}"`)}`),
    ", ",
  );
  const rows = await runAsOwner((tx) =>
    tx.$queryRaw<Array<Record<string, number>>>(Prisma.sql`
      WITH pop AS (
        SELECT ${featureFlagsSql(since)}
        FROM "Shop" s
        JOIN "User" u ON u."id" = s."ownerId"
        WHERE ${populationSql(since, now)} ${narrow}
      )
      SELECT count(*)::int AS "population", ${counts}
      FROM pop
    `),
  );
  const row = rows[0];
  const population = Number(row?.population ?? 0);
  if (!row || !adoptionPopulationVisible(population)) return null;
  const pct = {} as Record<FeatureAdoptionId, number>;
  for (const id of FEATURE_IDS) pct[id] = roundAdoptionPct(Number(row[id] ?? 0), population);
  return { pct };
}

/** Does THIS shop use each feature, by exactly the platform's definitions. */
export async function shopFeatureUsage(shopId: string, now: Date = new Date()): Promise<FeatureUsage> {
  const since = new Date(now.getTime() - FEATURE_ADOPTION.activeWindowDays * DAY_MS);
  // runAsOwner, not runWithShop: Shop reads inside a tenant transaction return
  // nothing (Shop RLS is default-deny). The WHERE pins it to the caller's shop.
  const rows = await runAsOwner((tx) =>
    tx.$queryRaw<Array<Record<string, boolean>>>(Prisma.sql`
      SELECT ${featureFlagsSql(since)} FROM "Shop" s WHERE s."id" = ${shopId}
    `),
  );
  const row = rows[0];
  const usage = {} as FeatureUsage;
  for (const id of FEATURE_IDS) usage[id] = row?.[id] === true;
  return usage;
}

// ---------------------------------------------------------------------------
// The cache.
//
// WHY AN IN-PROCESS CACHE AND NOT A DAILY JOB: a job would have to store its
// result somewhere every API replica can read - a new table, a migration and
// a job_lease seed row - to save at most one aggregate query per replica per
// day. The numbers are rounded to 5% and describe a month of activity, so a
// replica computing its own copy once a day is indistinguishable to a reader,
// and there is nothing to keep in sync. One computation per process per TTL;
// concurrent requests share the one in flight; a failure is remembered for a
// few minutes so a broken query cannot be retried on every page view.
// ---------------------------------------------------------------------------

const FAILURE_RETRY_MS = 5 * 60 * 1000;

type Source = (now: Date) => Promise<AdoptionTotals | null>;
const defaultSource: Source = (now) => computeFeatureAdoption({ now });

let source: Source = defaultSource;
let cached: { value: AdoptionTotals | null; expiresAt: number } | null = null;
let inflight: Promise<AdoptionTotals | null> | null = null;

/** The platform totals, computed at most once per FEATURE_ADOPTION.cacheTtlMs. */
export function getFeatureAdoptionTotals(now: Date = new Date()): Promise<AdoptionTotals | null> {
  if (cached && cached.expiresAt > now.getTime()) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  const started = now.getTime();
  const run = source(now).then(
    (value) => {
      cached = { value, expiresAt: started + FEATURE_ADOPTION.cacheTtlMs };
      return value;
    },
    (err: unknown) => {
      logger.warn({ err }, "feature adoption totals failed; hiding the card for now");
      cached = { value: null, expiresAt: started + FAILURE_RETRY_MS };
      return null;
    },
  );
  inflight = run.finally(() => {
    inflight = null;
  });
  return inflight;
}

/** TEST SEAM: swap what the cache computes from (and empty it). No arg = the real query. */
export function __setFeatureAdoptionSourceForTests(fn?: Source): void {
  source = fn ?? defaultSource;
  cached = null;
  inflight = null;
}
