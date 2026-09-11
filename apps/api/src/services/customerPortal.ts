import { runAsOwner, runWithShop } from "@chairback/db";
import {
  CUSTOMER_STATUS_LABEL,
  NEUTRAL_VOCABULARY,
  apiEnv,
  customerStatusForAppointment,
  customerStatusForVisit,
  formatShopAddress,
  isUpcomingStatus,
  requestedDetail,
  requestedReason,
  vocabularyForShop,
  type CustomerStatus,
} from "@chairback/config";
import { buildLoyaltyView, loadLoyaltyInputs } from "./loyaltyView.js";
import { syncCustomerLinks, type ActiveLink } from "./customerIdentity.js";

/**
 * MY CHAIRBACK'S READ MODEL - everything the customer home, history, details
 * and rewards screens show, built from the account's ACTIVE links only.
 *
 * Isolation, twice over, by construction:
 *   1. Which records: the account's own active links (services/
 *      customerIdentity.ts), re-derived from its proof on every call. No id
 *      from a request ever widens that set.
 *   2. How they're read: each shop's rows are read inside THAT shop's tenant
 *      transaction (runWithShop -> RLS), AND filtered to the linked client ids
 *      explicitly. A bug in either layer alone still cannot surface another
 *      shop's rows, or another customer's rows in the same shop.
 *
 * 🔴 EVERY FIELD IS AN EXPLICIT SELECT. Private barber text lives on the very
 * rows read here - Client.notes, Appointment.notes, Appointment.intake - and
 * the only thing keeping it off a customer's phone is that no select below
 * names it. A test seeds a marker in each and scans every /api/me reply.
 *
 * NATIVE + SYNCED, ONE HISTORY. A native booking is an Appointment; an
 * Acuity/Square booking is a Visit; and a completed native booking is BOTH
 * (the promoter writes a `booking:<id>` Visit, and a mirrored booking can be
 * linked to the Acuity Visit). The Appointment is the richer row, so it wins
 * and its Visit is dropped. Status goes through the one customer table
 * (@chairback/config customerStatus) - PENDING is Requested, never Booked.
 */

export type AppointmentSource = "chairback" | "acuity" | "square" | "manual";

export interface PortalShopRef {
  /** An opaque key for this shop within THIS account (its primary link id). */
  key: string;
  name: string;
  logoUrl: string | null;
  city: string | null;
  region: string | null;
}

export interface PortalAppointment {
  /** "a_<appointmentId>" (ChairBack) or "v_<visitId>" (synced / logged). */
  id: string;
  source: AppointmentSource;
  status: CustomerStatus;
  statusLabel: string;
  /** One line under the status - today only "who a request is waiting on". */
  statusDetail: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  serviceName: string | null;
  providerName: string | null;
  providerImageUrl: string | null;
  shop: PortalShopRef;
  /** Reschedule/cancel are available through the shop's own manage page. */
  canManage: boolean;
  /** Said instead, when this booking lives in another system. */
  manageNote: string | null;
}

export interface PortalAppointmentDetail extends PortalAppointment {
  address: string | null;
  durationMin: number | null;
  priceCents: number | null;
}

export interface PortalShop extends PortalShopRef {
  heroImageUrl: string | null;
  lastVisitAt: string | null;
  usualService: string | null;
  providerNoun: string;
  serviceNoun: string;
  rewardsEnabled: boolean;
  hasUpcoming: boolean;
}

export interface PortalRewardSummary {
  shop: PortalShopRef;
  cardName: string | null;
  balance: number;
  unit: "visits" | "punches";
  next: { rewardName: string; cost: number; remaining: number } | null;
  readyRewards: string[];
}

export interface PortalHome {
  firstName: string | null;
  vocabulary: { providerNounPlural: string; serviceNoun: string };
  next: PortalAppointment | null;
  upcomingCount: number;
  shops: PortalShop[];
  rewards: PortalRewardSummary[];
  recent: PortalAppointment[];
}

interface ShopRow {
  id: string;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  heroImageUrl: string | null;
  timezone: string;
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
  rewardsEnabled: boolean;
  punchesPerVisit: number;
  industry: string | null;
  serviceNoun: string | null;
  businessTypeSelectedAt: Date | null;
  tierThresholds: unknown;
  tierPerks: unknown;
}

interface ClientRow {
  id: string;
  firstName: string | null;
  lastVisitAt: Date | null;
  createdAt: Date;
}

interface ApptRow {
  id: string;
  clientId: string | null;
  status: "PENDING" | "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  startsAt: Date;
  endsAt: Date;
  holdReason: string | null;
  holdExpiresAt: Date | null;
  visitId: string | null;
  priceAtBooking: { toString(): string } | null;
  service: { name: string; durationMin: number } | null;
  staff: { name: string; imageUrl: string | null } | null;
}

interface VisitRow {
  id: string;
  clientId: string;
  acuityAppointmentId: string;
  status: "SCHEDULED" | "RESCHEDULED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
  scheduledAt: Date;
  endAt: Date | null;
  serviceName: string | null;
  price: { toString(): string } | null;
}

/** One shop as the account sees it: its rows, already normalized. */
export interface PortalShopBundle {
  shop: ShopRow;
  ref: PortalShopRef;
  links: ActiveLink[];
  clients: ClientRow[];
  /** The record rewards and the storefront speak for (latest activity wins). */
  primaryClientId: string;
  events: (PortalAppointmentDetail & { clientId: string })[];
}

/** How far back history reaches per shop. A decade of visits is a long scroll. */
const HISTORY_PER_SHOP = 200;
/** A booking with no end time is treated as an hour long for "is it still on". */
const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

function sourceForVisit(acuityAppointmentId: string): AppointmentSource {
  if (/^\d+$/.test(acuityAppointmentId)) return "acuity";
  if (acuityAppointmentId.startsWith("square:")) return "square";
  if (acuityAppointmentId.startsWith("manual:")) return "manual";
  return "chairback";
}

function cents(v: { toString(): string } | null): number | null {
  if (v === null) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function isUpcoming(e: { status: CustomerStatus; startsAt: string; endsAt: string | null }, now: Date): boolean {
  if (!isUpcomingStatus(e.status)) return false;
  const end = e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + DEFAULT_LENGTH_MS;
  return end > now.getTime();
}

/** Load every linked shop, each through its own tenant transaction. */
export async function loadPortal(accountId: string, now = new Date()): Promise<PortalShopBundle[]> {
  const links = await syncCustomerLinks(accountId, now);
  if (links.length === 0) return [];

  const byShop = new Map<string, ActiveLink[]>();
  for (const l of links) byShop.set(l.shopId, [...(byShop.get(l.shopId) ?? []), l]);

  // Shop rows are platform-shaped (default-deny under a tenant session - the
  // known gotcha), so they are read as owner, by the ids the links name.
  const shops = await runAsOwner((tx) =>
    tx.shop.findMany({
      where: { id: { in: [...byShop.keys()] } },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        heroImageUrl: true,
        timezone: true,
        addressStreet: true,
        addressCity: true,
        addressRegion: true,
        addressPostal: true,
        rewardsEnabled: true,
        punchesPerVisit: true,
        industry: true,
        serviceNoun: true,
        businessTypeSelectedAt: true,
        tierThresholds: true,
        tierPerks: true,
      },
    }),
  );

  const bundles: PortalShopBundle[] = [];
  for (const shop of shops) {
    const shopLinks = byShop.get(shop.id) ?? [];
    const clientIds = shopLinks.map((l) => l.clientId);
    const { clients, appts, visits } = await runWithShop(shop.id, async (tx) => {
      const [clients, appts, visits] = await Promise.all([
        tx.client.findMany({
          where: { shopId: shop.id, id: { in: clientIds } },
          select: { id: true, firstName: true, lastVisitAt: true, createdAt: true },
        }),
        tx.appointment.findMany({
          where: { shopId: shop.id, clientId: { in: clientIds } },
          orderBy: { startsAt: "desc" },
          take: HISTORY_PER_SHOP,
          select: {
            id: true,
            clientId: true,
            status: true,
            startsAt: true,
            endsAt: true,
            holdReason: true,
            holdExpiresAt: true,
            visitId: true,
            priceAtBooking: true,
            service: { select: { name: true, durationMin: true } },
            staff: { select: { name: true, imageUrl: true } },
          },
        }),
        tx.visit.findMany({
          where: { shopId: shop.id, clientId: { in: clientIds } },
          orderBy: { scheduledAt: "desc" },
          take: HISTORY_PER_SHOP,
          select: {
            id: true,
            clientId: true,
            acuityAppointmentId: true,
            status: true,
            scheduledAt: true,
            endAt: true,
            serviceName: true,
            price: true,
          },
        }),
      ]);
      return { clients, appts: appts as ApptRow[], visits: visits as VisitRow[] };
    });

    const ref: PortalShopRef = {
      key: shopLinks[0]!.id,
      name: shop.name,
      logoUrl: shop.logoUrl,
      city: shop.addressCity,
      region: shop.addressRegion,
    };
    const events = normalizeEvents(shop, ref, appts, visits, now);

    // The primary record: the one with the latest activity, else the oldest link.
    const lastActivity = new Map<string, number>();
    for (const e of events) {
      const t = Date.parse(e.startsAt);
      if ((lastActivity.get(e.clientId) ?? -Infinity) < t) lastActivity.set(e.clientId, t);
    }
    for (const c of clients) {
      const t = c.lastVisitAt?.getTime();
      if (t !== undefined && (lastActivity.get(c.id) ?? -Infinity) < t) lastActivity.set(c.id, t);
    }
    const primary =
      [...shopLinks].sort(
        (a, b) => (lastActivity.get(b.clientId) ?? -Infinity) - (lastActivity.get(a.clientId) ?? -Infinity),
      )[0] ?? shopLinks[0]!;
    ref.key = primary.id;
    for (const e of events) e.shop = ref;

    bundles.push({
      shop: shop as ShopRow,
      ref,
      links: shopLinks,
      clients,
      primaryClientId: primary.clientId,
      events,
    });
  }
  return bundles;
}

function normalizeEvents(
  shop: ShopRow,
  ref: PortalShopRef,
  appts: ApptRow[],
  visits: VisitRow[],
  now: Date,
): (PortalAppointmentDetail & { clientId: string })[] {
  const address = formatShopAddress(shop);
  const out: (PortalAppointmentDetail & { clientId: string })[] = [];
  const apptIds = new Set(appts.map((a) => a.id));
  const visitIdsOwnedByAppointments = new Set(
    appts.map((a) => a.visitId).filter((v): v is string => v !== null),
  );

  for (const a of appts) {
    if (!a.clientId) continue;
    // A lapsed hold is already dead (the sweep will cancel it) and a request
    // whose time passed without an answer never happened: neither belongs on
    // a customer's list.
    if (a.status === "PENDING") {
      if (a.holdExpiresAt && a.holdExpiresAt.getTime() <= now.getTime()) continue;
      if (a.endsAt.getTime() <= now.getTime()) continue;
    }
    const status = customerStatusForAppointment(a.status);
    out.push({
      id: `a_${a.id}`,
      clientId: a.clientId,
      source: "chairback",
      status,
      statusLabel: CUSTOMER_STATUS_LABEL[status],
      statusDetail:
        status === "requested"
          ? requestedDetail(requestedReason({ holdReason: a.holdReason, holdExpiresAt: a.holdExpiresAt }), shop.name)
          : null,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      timezone: shop.timezone,
      serviceName: a.service?.name ?? null,
      providerName: a.staff?.name ?? null,
      providerImageUrl: a.staff?.imageUrl ?? null,
      shop: ref,
      // The same rule the manage page enforces for its buttons.
      canManage: a.status === "BOOKED" && a.startsAt.getTime() > now.getTime(),
      manageNote: null,
      address,
      durationMin: a.service?.durationMin ?? null,
      priceCents: cents(a.priceAtBooking),
    });
  }

  for (const v of visits) {
    // The same event as an Appointment already listed: the promoter's
    // booking:<id> Visit, or the Acuity Visit a mirrored booking points at.
    if (visitIdsOwnedByAppointments.has(v.id)) continue;
    if (v.acuityAppointmentId.startsWith("booking:") && apptIds.has(v.acuityAppointmentId.slice(8))) {
      continue;
    }
    const status = customerStatusForVisit(v.status);
    const source = sourceForVisit(v.acuityAppointmentId);
    const upcoming = isUpcomingStatus(status) && v.scheduledAt.getTime() > now.getTime();
    out.push({
      id: `v_${v.id}`,
      clientId: v.clientId,
      source,
      status,
      statusLabel: CUSTOMER_STATUS_LABEL[status],
      statusDetail: null,
      startsAt: v.scheduledAt.toISOString(),
      endsAt: v.endAt?.toISOString() ?? null,
      timezone: shop.timezone,
      serviceName: v.serviceName,
      // Synced visits carry no staff - naming a barber would be a guess.
      providerName: null,
      providerImageUrl: null,
      shop: ref,
      canManage: false,
      manageNote:
        upcoming && (source === "acuity" || source === "square")
          ? `To change this visit, contact ${shop.name}.`
          : null,
      address,
      durationMin: null,
      priceCents: cents(v.price),
    });
  }
  return out;
}

/** Strip the fields only the detail screen needs, for list rows. */
function listRow(e: PortalAppointmentDetail & { clientId: string }): PortalAppointment {
  return {
    id: e.id,
    source: e.source,
    status: e.status,
    statusLabel: e.statusLabel,
    statusDetail: e.statusDetail,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    timezone: e.timezone,
    serviceName: e.serviceName,
    providerName: e.providerName,
    providerImageUrl: e.providerImageUrl,
    shop: e.shop,
    canManage: e.canManage,
    manageNote: e.manageNote,
  };
}

export function splitHistory(
  bundles: PortalShopBundle[],
  now = new Date(),
): { upcoming: PortalAppointment[]; past: PortalAppointment[] } {
  const all = bundles.flatMap((b) => b.events);
  const upcoming = all
    .filter((e) => isUpcoming(e, now))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .map(listRow);
  const past = all
    .filter((e) => !isUpcoming(e, now))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .map(listRow);
  return { upcoming, past };
}

export function findEvent(bundles: PortalShopBundle[], id: string): PortalAppointmentDetail | null {
  for (const b of bundles) {
    const e = b.events.find((x) => x.id === id);
    if (e) {
      const { clientId: _clientId, ...detail } = e;
      return detail;
    }
  }
  return null;
}

function vocabularyOf(shop: ShopRow) {
  return vocabularyForShop({
    industry: shop.industry,
    serviceNoun: shop.serviceNoun,
    businessTypeSelectedAt: shop.businessTypeSelectedAt,
  });
}

function shopCards(bundles: PortalShopBundle[], now: Date): PortalShop[] {
  return bundles
    .map((b) => {
      const done = b.events
        .filter((e) => e.status === "completed")
        .sort((x, y) => Date.parse(y.startsAt) - Date.parse(x.startsAt));
      const clientLast = b.clients
        .map((c) => c.lastVisitAt?.getTime() ?? null)
        .filter((t): t is number => t !== null)
        .sort((x, y) => y - x)[0];
      const lastVisitAt = done[0]?.startsAt ?? (clientLast ? new Date(clientLast).toISOString() : null);
      const vocab = vocabularyOf(b.shop);
      return {
        ...b.ref,
        heroImageUrl: b.shop.heroImageUrl,
        lastVisitAt,
        usualService: done.find((e) => e.serviceName)?.serviceName ?? null,
        providerNoun: vocab.providerNoun,
        serviceNoun: vocab.serviceNoun,
        rewardsEnabled: b.shop.rewardsEnabled,
        hasUpcoming: b.events.some((e) => isUpcoming(e, now)),
      };
    })
    .sort((a, b) => {
      if (a.hasUpcoming !== b.hasUpcoming) return a.hasUpcoming ? -1 : 1;
      return (b.lastVisitAt ? Date.parse(b.lastVisitAt) : 0) - (a.lastVisitAt ? Date.parse(a.lastVisitAt) : 0);
    });
}

/**
 * The home's words. When every linked shop speaks the same vocabulary (all
 * barbershops: "Your barbers", "your next cut") the home speaks it too; mixed
 * or none, it falls back to the neutral words rather than calling a stylist a
 * barber.
 */
function homeVocabulary(bundles: PortalShopBundle[]): PortalHome["vocabulary"] {
  const vocabs = bundles.map((b) => vocabularyOf(b.shop));
  const first = vocabs[0];
  const unanimous = (k: "providerNounPlural" | "serviceNoun") =>
    first !== undefined && vocabs.every((v) => v[k] === first[k]) ? first[k] : NEUTRAL_VOCABULARY[k];
  return { providerNounPlural: unanimous("providerNounPlural"), serviceNoun: unanimous("serviceNoun") };
}

export async function buildHome(accountId: string, now = new Date()): Promise<PortalHome> {
  const [account, bundles] = await Promise.all([
    runAsOwner((tx) =>
      tx.customerAccount.findUnique({ where: { id: accountId }, select: { firstName: true } }),
    ),
    loadPortal(accountId, now),
  ]);
  const { upcoming, past } = splitHistory(bundles, now);
  const programs = await rewardPrograms(bundles);
  return {
    firstName: account?.firstName ?? null,
    vocabulary: homeVocabulary(bundles),
    next: upcoming[0] ?? null,
    upcomingCount: upcoming.length,
    shops: shopCards(bundles, now),
    rewards: programs.map(summarize).filter((s): s is PortalRewardSummary => s !== null),
    recent: past.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export interface PortalRewardCard {
  name: string | null;
  balance: number;
  unit: "visits" | "punches";
  next: { rewardName: string; cost: number; remaining: number } | null;
  rewards: { name: string; description: string | null; cost: number; ready: boolean; remaining: number }[];
}

export interface PortalRewardProgram {
  shop: PortalShopRef;
  tier: {
    label: string | null;
    visits: number;
    perk: string | null;
    next: { label: string; visitsAway: number; perk: string | null } | null;
  };
  cards: PortalRewardCard[];
  activity: { date: string; kind: "earned" | "redeemed" | "bonus" | "adjusted"; punches: number; label: string }[];
  /** Another of this customer's records at the SAME shop holds punches too. */
  otherProfileHasPunches: boolean;
}

/**
 * One program per shop with rewards switched on AND something to earn. A
 * shop with rewards off - or on, with an empty menu - has no program: the
 * customer sees nothing for it, never a zero-value card.
 *
 * Scope is one record at one shop (the primary). Balances are never added
 * across shops, and never across one shop's duplicate records either: the
 * duplicate is FLAGGED so the customer can ask the shop to combine them.
 */
export async function rewardPrograms(bundles: PortalShopBundle[]): Promise<PortalRewardProgram[]> {
  const programs: PortalRewardProgram[] = [];
  for (const b of bundles) {
    if (!b.shop.rewardsEnabled) continue;
    const primary = b.primaryClientId;
    const others = b.links.map((l) => l.clientId).filter((id) => id !== primary);
    const data = await runWithShop(b.shop.id, async (tx) => {
      const inputs = await loadLoyaltyInputs(tx, b.shop.id, primary);
      const [earnRules, cardUnits, ledger, otherBalances] = await Promise.all([
        tx.earnRule.count({ where: { shopId: b.shop.id, active: true } }),
        tx.cardType.findMany({ where: { shopId: b.shop.id }, select: { id: true, punchesPerVisit: true } }),
        tx.punchLedger.findMany({
          where: { shopId: b.shop.id, clientId: primary },
          // Ties on createdAt (rows written in one transaction) break on id,
          // so the list never reorders itself between two loads.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
          select: {
            createdAt: true,
            punchesEarned: true,
            punchesRedeemed: true,
            note: true,
            visitId: true,
            reversalOfId: true,
            correctionOfId: true,
            reward: { select: { name: true } },
            visit: { select: { serviceName: true } },
          },
        }),
        others.length === 0
          ? Promise.resolve([])
          : tx.punchLedger.groupBy({
              by: ["clientId"],
              where: { shopId: b.shop.id, clientId: { in: others } },
              _sum: { punchesEarned: true, punchesRedeemed: true },
            }),
      ]);
      return { inputs, earnRules, cardUnits, ledger, otherBalances };
    });

    if (data.inputs.rewards.length === 0) continue;
    const view = buildLoyaltyView(
      { tierThresholds: b.shop.tierThresholds as never, tierPerks: b.shop.tierPerks as never },
      data.inputs,
    );
    const perVisit = new Map(data.cardUnits.map((c) => [c.id, c.punchesPerVisit]));
    const unitFor = (cardId: string | null): "visits" | "punches" =>
      cardId === null
        ? b.shop.punchesPerVisit === 1 && data.earnRules === 0
          ? "visits"
          : "punches"
        : perVisit.get(cardId) === 1
          ? "visits"
          : "punches";

    const cards: PortalRewardCard[] = view.cards
      .filter((c) => c.rewards.length > 0 || c.balance > 0)
      .map((c) => ({
        name: c.id === null ? null : c.name,
        balance: c.balance,
        unit: unitFor(c.id),
        next: c.nextTarget
          ? { rewardName: c.nextTarget.name, cost: c.nextTarget.punchCost, remaining: c.nextTarget.remaining }
          : null,
        rewards: c.rewards.map((r) => ({
          name: r.name,
          description: r.description,
          cost: r.punchCost,
          ready: r.ready,
          remaining: r.remaining,
        })),
      }));

    programs.push({
      shop: b.ref,
      tier: {
        label: view.loyalty.label,
        visits: view.loyalty.visits,
        perk: view.loyalty.perk,
        next: view.loyalty.nextTier,
      },
      cards,
      activity: data.ledger.map((row) => {
        const punches = row.punchesEarned - row.punchesRedeemed;
        // 🔴 A correction's note can carry a barber's words ("undo: ..."), so
        // corrections are labelled by KIND, never by note. Redemptions show
        // the reward's name, as the storefront always has.
        if (row.reversalOfId !== null || row.correctionOfId !== null) {
          return { date: row.createdAt.toISOString(), kind: "adjusted" as const, punches, label: "Adjustment" };
        }
        if (row.punchesRedeemed > 0) {
          return {
            date: row.createdAt.toISOString(),
            kind: "redeemed" as const,
            punches,
            label: row.reward?.name ?? "Reward",
          };
        }
        if (row.visitId !== null) {
          return {
            date: row.createdAt.toISOString(),
            kind: "earned" as const,
            punches,
            label: row.visit?.serviceName ?? "Visit",
          };
        }
        return { date: row.createdAt.toISOString(), kind: "bonus" as const, punches, label: "Bonus" };
      }),
      otherProfileHasPunches: data.otherBalances.some(
        (g) => (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0) > 0,
      ),
    });
  }
  return programs;
}

function summarize(p: PortalRewardProgram): PortalRewardSummary | null {
  // The card closest to paying out leads: a ready reward first, then the
  // smallest remaining gap.
  const ranked = [...p.cards].sort((a, b) => {
    const readyA = a.rewards.some((r) => r.ready) ? 0 : 1;
    const readyB = b.rewards.some((r) => r.ready) ? 0 : 1;
    if (readyA !== readyB) return readyA - readyB;
    return (a.next?.remaining ?? Infinity) - (b.next?.remaining ?? Infinity);
  });
  const card = ranked[0];
  if (!card) return null;
  return {
    shop: p.shop,
    cardName: card.name,
    balance: card.balance,
    unit: card.unit,
    next: card.next,
    readyRewards: card.rewards.filter((r) => r.ready).map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// Links out to the shop's own pages
// ---------------------------------------------------------------------------

function base(): string {
  return apiEnv().APP_BASE_URL.replace(/\/$/, "");
}

/**
 * The shop's existing storefront, as this customer's own record sees it
 * (/r/<token>: the shop page with their rewards one tap in). Issued on tap,
 * never listed. The key must be one of the account's own ACTIVE link ids.
 */
export async function storefrontUrl(accountId: string, linkKey: string): Promise<string | null> {
  const links = await syncCustomerLinks(accountId);
  const link = links.find((l) => l.id === linkKey);
  if (!link) return null;
  const client = await runWithShop(link.shopId, (tx) =>
    tx.client.findFirst({
      where: { id: link.clientId, shopId: link.shopId },
      select: { magicToken: true },
    }),
  );
  return client ? `${base()}/r/${client.magicToken}` : null;
}

/**
 * The shop's existing manage page for one ChairBack booking - where
 * reschedule, cancel, and every fee rule that goes with them already live.
 * Only a native appointment ("a_" id) on one of the account's linked records.
 */
export async function manageUrl(accountId: string, eventId: string): Promise<string | null> {
  if (!/^a_[A-Za-z0-9]{8,40}$/.test(eventId)) return null;
  const apptId = eventId.slice(2);
  const links = await syncCustomerLinks(accountId);
  const byShop = new Map<string, string[]>();
  for (const l of links) byShop.set(l.shopId, [...(byShop.get(l.shopId) ?? []), l.clientId]);
  for (const [shopId, clientIds] of byShop) {
    const appt = await runWithShop(shopId, (tx) =>
      tx.appointment.findFirst({
        where: { id: apptId, shopId, clientId: { in: clientIds } },
        select: { manageToken: true },
      }),
    );
    if (appt) return `${base()}/book/manage/${appt.manageToken}`;
  }
  return null;
}
