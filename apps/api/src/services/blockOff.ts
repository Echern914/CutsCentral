import { randomUUID } from "node:crypto";
import { Prisma, runWithShop } from "@chairback/db";
import { zonedDateKey } from "@chairback/config";
import { describeBlockScope, MAX_BLOCK_SERVICES } from "@chairback/config/blockScope";
import { lockStaffCalendars } from "../engines/bookingWrite.js";
import {
  blockOverAppointmentsConfirmation,
  CONFLICTS_DESCRIBED,
  dayKeyOf,
  daySpans,
  describeAppointmentConflicts,
  findAppointmentsInSpans,
  MAX_BLOCK_DAYS,
  parseDayKey,
  planDayRangeBlock,
  todayKeyIn,
  type BlockConflictRow,
  type DayWindow,
} from "./blockOffDays.js";

/**
 * "Block off time" as ONE thing a barber makes, sees, changes and takes back.
 *
 * ── WHAT A SAVE WRITES ───────────────────────────────────────────────────────
 *
 * One AvailabilityException row per barber per shop-local day, exactly as
 * before (services/blockOffDays.ts has why rows are day-shaped). What is new
 * is that the rows of one save carry:
 *
 *   - `groupId`   - so "the whole group" can be edited or removed as one;
 *   - `requestId` - the form's once-per-Save id, so a retried save answers
 *                   from the rows the first try wrote instead of writing a
 *                   second copy (a unique index is the backstop);
 *   - `pattern`   - what the barber asked for, because two different asks can
 *                   cover the same days:
 *       "daily"      every day from Mon through Fri, 12:00-13:00 - rows with
 *                    gaps between them, the afternoons stay bookable;
 *       "continuous" from Mon 9:00 through Fri 17:00 - one unbroken absence,
 *                    stored as touching per-day rows (first day from 9:00,
 *                    whole days between, last day until 17:00);
 *       "weekly"     the same day-of-week block, a bounded number of weeks;
 *       "single"     one span on one day.
 *
 * ── ONE SCHEDULING SYSTEM ────────────────────────────────────────────────────
 *
 * Nothing here computes availability. The slot grid subtracts these rows
 * (engines/slots.ts) and the booking write guard refuses them under the
 * chair's lock (engines/bookingWrite.ts `nativeBlocks`), so removing a block
 * can never "reopen" time another block or a booking still holds: whatever
 * rows remain are simply what is subtracted.
 *
 * ── A BLOCK NEVER TOUCHES AN APPOINTMENT ─────────────────────────────────────
 *
 * Unchanged from blockOffDays.ts: a block over bookings is refused with the
 * bookings it found and a digest of exactly those rows; it is written only
 * when that digest comes back. Bookings are never moved or cancelled. Every
 * chosen barber is checked under his own chair lock, all taken up front in
 * one sorted order (lockStaffCalendars) so two saves over the same barbers
 * cannot deadlock.
 */

/** The longest weekly repeat. Matches recurring appointment series. */
export const MAX_REPEAT_WEEKS = 52;
/** Barbers one save may cover. */
export const MAX_BLOCK_STAFF = 20;
/** Rows one save may write (days x barbers). */
export const MAX_BLOCK_ROWS = 1000;

export type BlockPattern = "single" | "daily" | "continuous" | "weekly";

export type BlockWhen =
  /** One day: all day, or `window` on it; optionally the same block weekly. */
  | {
      kind: "day";
      date: string;
      window?: DayWindow;
      repeat?: { weeks: number } | { until: string };
    }
  /** The same hours (or all day) on EACH day from fromDate through toDate. */
  | { kind: "daily"; fromDate: string; toDate: string; window?: DayWindow }
  /** One unbroken absence: fromDate at fromMin through toDate at toMin. */
  | { kind: "continuous"; fromDate: string; fromMin: number; toDate: string; toMin: number }
  /** Two instants, as the timed form always sent them. */
  | { kind: "instant"; startsAt: Date; endsAt: Date };

export interface PlannedSpan {
  startsAt: Date;
  endsAt: Date;
}

export type BlockPlanResult =
  | { ok: true; spans: PlannedSpan[]; pattern: BlockPattern }
  | { ok: false; field: string; message: string };

const DAY_MS = 24 * 60 * 60_000;

/** `key` moved by `days` calendar days, by UTC day arithmetic. */
function shiftKey(key: string, days: number): string | null {
  const p = parseDayKey(key);
  if (!p) return null;
  const d = new Date(Date.UTC(p.year, p.month0, p.day) + days * DAY_MS);
  return dayKeyOf({ year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() });
}

/**
 * The spans a request asks for, every edge resolved in the SHOP's zone per
 * day (so a weekly 12:00 block is 12:00 on both sides of a DST change). Pure.
 */
export function planBlock(when: BlockWhen, timezone: string, now: Date): BlockPlanResult {
  if (when.kind === "instant") {
    if (!(when.endsAt.getTime() > when.startsAt.getTime())) {
      return { ok: false, field: "endsAt", message: "End must be after start." };
    }
    return { ok: true, spans: [{ startsAt: when.startsAt, endsAt: when.endsAt }], pattern: "single" };
  }

  if (when.kind === "daily") {
    const plan = planDayRangeBlock({
      fromDate: when.fromDate,
      toDate: when.toDate,
      timezone,
      now,
      window: when.window,
    });
    if (!plan.ok) return plan;
    return {
      ok: true,
      spans: plan.spans.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
      pattern: plan.spans.length === 1 ? "single" : "daily",
    };
  }

  if (when.kind === "day") {
    const first = planDayRangeBlock({
      fromDate: when.date,
      toDate: when.date,
      timezone,
      now,
      window: when.window,
    });
    if (!first.ok) return first.field === "toDate" ? { ...first, field: "date" } : first;
    if (!when.repeat) {
      return {
        ok: true,
        spans: first.spans.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
        pattern: "single",
      };
    }
    let count: number;
    if ("weeks" in when.repeat) {
      count = when.repeat.weeks;
      if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT_WEEKS) {
        return {
          ok: false,
          field: "repeat",
          message: `Repeat from 1 to ${MAX_REPEAT_WEEKS} weeks.`,
        };
      }
    } else {
      const until = parseDayKey(when.repeat.until);
      if (!until) return { ok: false, field: "repeat", message: "Pick a real end date for the repeat." };
      if (when.repeat.until < when.date) {
        return { ok: false, field: "repeat", message: "The repeat must end on or after the first day." };
      }
      const start = parseDayKey(when.date)!;
      const days = Math.round(
        (Date.UTC(until.year, until.month0, until.day) - Date.UTC(start.year, start.month0, start.day)) /
          DAY_MS,
      );
      count = Math.floor(days / 7) + 1;
      if (count > MAX_REPEAT_WEEKS) {
        return { ok: false, field: "repeat", message: `Repeat up to ${MAX_REPEAT_WEEKS} weeks.` };
      }
    }
    const spans: PlannedSpan[] = [];
    for (let k = 0; k < count; k++) {
      const key = shiftKey(when.date, 7 * k)!;
      const p = parseDayKey(key)!;
      // Resolved per occurrence: the wall clock stays put, the offset moves.
      const [s] = daySpans(p, p, timezone, when.window);
      spans.push({ startsAt: s!.startsAt, endsAt: s!.endsAt });
    }
    return { ok: true, spans, pattern: count === 1 ? "single" : "weekly" };
  }

  // continuous
  const from = parseDayKey(when.fromDate);
  if (!from) return { ok: false, field: "fromDate", message: "Pick a real start date." };
  const to = parseDayKey(when.toDate);
  if (!to) return { ok: false, field: "toDate", message: "Pick a real end date." };
  if (when.toDate < when.fromDate) {
    return { ok: false, field: "toDate", message: "The end date must be on or after the start date." };
  }
  if (when.toDate < todayKeyIn(now, timezone)) {
    return { ok: false, field: "toDate", message: "Those days have already passed." };
  }
  if (!Number.isInteger(when.fromMin) || when.fromMin < 0 || when.fromMin >= 24 * 60) {
    return { ok: false, field: "fromMin", message: "Pick a real start time." };
  }
  if (!Number.isInteger(when.toMin) || when.toMin < 0 || when.toMin > 24 * 60) {
    return { ok: false, field: "toMin", message: "Pick a real end time." };
  }
  const days = daySpans(from, to, timezone);
  if (days.length > MAX_BLOCK_DAYS) {
    return { ok: false, field: "toDate", message: `Block up to ${MAX_BLOCK_DAYS} days at a time.` };
  }
  // The first day from its start time, the last day until its end time, the
  // days between whole: touching rows, one absence.
  const [firstStart] = daySpans(from, from, timezone, { fromMin: when.fromMin, toMin: 24 * 60 });
  const [lastEnd] = daySpans(to, to, timezone, { fromMin: 0, toMin: Math.max(1, when.toMin) });
  const spans = days
    .map((d, i) => ({
      startsAt: i === 0 ? firstStart!.startsAt : d.startsAt,
      endsAt: i === days.length - 1 ? (when.toMin === 0 ? d.startsAt : lastEnd!.endsAt) : d.endsAt,
    }))
    .filter((s) => s.endsAt.getTime() > s.startsAt.getTime());
  if (spans.length === 0) {
    return { ok: false, field: "toMin", message: "The end must be after the start." };
  }
  return { ok: true, spans, pattern: spans.length === 1 ? "single" : "continuous" };
}

/** A booking in the way, and on whose chair. */
export interface StaffConflictRow extends BlockConflictRow {
  staffId: string;
  staffName: string;
}

/**
 * The refusal's lines. One barber: blockOffDays' own wording. Several: the
 * barber's name leads each line, so "Sam · Tue, Sep 10, 2:00-2:30 PM ..." says
 * whose chair it is on.
 */
export function describeStaffConflicts(
  rows: StaffConflictRow[],
  timezone: string,
  manyStaff: boolean,
): string[] {
  const sorted = [...rows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (!manyStaff) return describeAppointmentConflicts(sorted, timezone);
  const lines = sorted
    .slice(0, CONFLICTS_DESCRIBED)
    .map((r) => `${r.staffName} · ${describeAppointmentConflicts([r], timezone)[0]}`);
  const rest = sorted.length - lines.length;
  if (rest > 0) lines.push(`+${rest} more`);
  return lines;
}

async function conflictsFor(
  tx: Prisma.TransactionClient,
  shopId: string,
  byStaff: Map<string, PlannedSpan[]>,
  names: Map<string, string>,
  now: Date,
  /** The block's services; [] = every booking is in the way. */
  serviceIds: readonly string[],
): Promise<StaffConflictRow[]> {
  const out: StaffConflictRow[] = [];
  for (const staffId of [...byStaff.keys()].sort()) {
    const rows = await findAppointmentsInSpans(tx, {
      shopId,
      staffId,
      spans: byStaff.get(staffId)!,
      now,
      serviceIds,
    });
    for (const r of rows) out.push({ ...r, staffId, staffName: names.get(staffId) ?? "Provider" });
  }
  return out;
}

/**
 * The services a block may name: this shop's own, offered by EVERY chosen
 * barber (a block names what it stops on each chair it covers, so a service
 * one of them does not do is a mistake to refuse, not a no-op to store).
 * Returns the offending ids, [] when all are fine.
 */
async function unknownBlockServices(
  tx: Prisma.TransactionClient,
  shopId: string,
  staffIds: readonly string[],
  serviceIds: readonly string[],
): Promise<string[]> {
  if (serviceIds.length === 0) return [];
  const offered = await tx.serviceStaff.findMany({
    where: { shopId, staffId: { in: [...staffIds] }, serviceId: { in: [...serviceIds] } },
    select: { staffId: true, serviceId: true },
  });
  const have = new Set(offered.map((o) => `${o.staffId}|${o.serviceId}`));
  return serviceIds.filter((sid) => staffIds.some((st) => !have.has(`${st}|${sid}`)));
}

export const UNKNOWN_SERVICES_MESSAGE =
  "Pick services every chosen provider offers, or choose All services.";

export type CreateBlocksOutcome =
  | { kind: "not_found" }
  | { kind: "bad_services"; message: string }
  | { kind: "too_many"; message: string }
  | { kind: "conflict"; conflicts: StaffConflictRow[]; confirmation: string }
  | {
      kind: "created";
      count: number;
      overlapping: number;
      groupId: string;
      /** True when this answered a retry from the rows an earlier try wrote. */
      replayed: boolean;
    };

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

/**
 * Write one save: `spans` on every barber in `staffIds`, as one group.
 *
 * Under every chosen chair's lock (sorted): a retry with the same `requestId`
 * is answered from the rows already written; otherwise the bookings in the way
 * on each chair are read and the save is refused unless `confirmation` names
 * exactly them. isBlock:false (a one-off OPEN window, the old staff endpoint)
 * skips the conflict check - opening time cannot sit on a booking.
 */
export async function createBlocks(input: {
  shopId: string;
  timezone: string;
  staffIds: string[];
  spans: PlannedSpan[];
  pattern: BlockPattern;
  isBlock: boolean;
  reason: string | null;
  requestId: string | null;
  confirmation: string | null;
  now: Date;
  /**
   * Which services the block stops: [] = all of them (the whole chair). Ignored
   * for an open window (isBlock:false), which opens the chair for everything.
   */
  serviceIds?: readonly string[];
}): Promise<CreateBlocksOutcome> {
  const staffIds = [...new Set(input.staffIds)].sort();
  const serviceIds = input.isBlock ? [...new Set(input.serviceIds ?? [])].sort() : [];
  if (serviceIds.length > MAX_BLOCK_SERVICES) {
    return { kind: "bad_services", message: `Pick up to ${MAX_BLOCK_SERVICES} services.` };
  }
  if (staffIds.length === 0) return { kind: "not_found" };
  if (staffIds.length > MAX_BLOCK_STAFF) {
    return { kind: "too_many", message: `Pick up to ${MAX_BLOCK_STAFF} providers at a time.` };
  }
  if (staffIds.length * input.spans.length > MAX_BLOCK_ROWS) {
    return {
      kind: "too_many",
      message: "That is more than one save can block. Pick fewer days or fewer providers.",
    };
  }

  const replay = async (tx: Prisma.TransactionClient) => {
    if (!input.requestId) return null;
    const prior = await tx.availabilityException.findMany({
      where: { shopId: input.shopId, requestId: input.requestId },
      select: { staffId: true, startsAt: true, endsAt: true, groupId: true, serviceIds: true },
    });
    if (prior.length === 0) return null;
    const byStaff = new Map<string, PlannedSpan[]>();
    for (const r of prior) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
    // The FIRST try's scope, not this request's: the replay answers for the
    // rows that exist.
    const overlapping = await conflictsFor(
      tx,
      input.shopId,
      byStaff,
      new Map(),
      input.now,
      prior[0]!.serviceIds,
    );
    return {
      kind: "created" as const,
      count: prior.length,
      overlapping: overlapping.length,
      groupId: prior[0]!.groupId ?? "",
      replayed: true,
    };
  };

  try {
    return await runWithShop(
      input.shopId,
      async (tx): Promise<CreateBlocksOutcome> => {
        const staff = await tx.staff.findMany({
          where: { id: { in: staffIds }, shopId: input.shopId },
          select: { id: true, name: true },
        });
        if (staff.length !== staffIds.length) return { kind: "not_found" };
        const names = new Map(staff.map((s) => [s.id, s.name]));

        // Every chair this save touches, in ONE order, before anything is read:
        // a booking racing the block waits, and so does a retry of this save.
        await lockStaffCalendars(tx, staffIds);

        const prior = await replay(tx);
        if (prior) return prior;

        if ((await unknownBlockServices(tx, input.shopId, staffIds, serviceIds)).length > 0) {
          return { kind: "bad_services", message: UNKNOWN_SERVICES_MESSAGE };
        }

        let conflicts: StaffConflictRow[] = [];
        if (input.isBlock) {
          const byStaff = new Map(staffIds.map((id) => [id, input.spans]));
          conflicts = await conflictsFor(tx, input.shopId, byStaff, names, input.now, serviceIds);
          if (conflicts.length > 0) {
            const confirmation = blockOverAppointmentsConfirmation(conflicts);
            if (input.confirmation !== confirmation) {
              return { kind: "conflict", conflicts, confirmation };
            }
          }
        }

        const groupId = randomUUID();
        await tx.availabilityException.createMany({
          data: staffIds.flatMap((staffId) =>
            input.spans.map((s) => ({
              shopId: input.shopId,
              staffId,
              startsAt: s.startsAt,
              endsAt: s.endsAt,
              isBlock: input.isBlock,
              reason: input.reason,
              groupId,
              requestId: input.requestId,
              pattern: input.pattern,
              serviceIds,
            })),
          ),
        });
        return {
          kind: "created",
          count: staffIds.length * input.spans.length,
          overlapping: conflicts.length,
          groupId,
          replayed: false,
        };
      },
      TX_OPTS,
    );
  } catch (err) {
    // The unique (shopId, requestId, staffId, startsAt) refused a second copy
    // of this save that got past the read above. Answer from the first.
    if (input.requestId && isUniqueViolation(err)) {
      const prior = await runWithShop(input.shopId, replay);
      if (prior) return prior;
    }
    throw err;
  }
}

/** A block as the edit sheet reads it. */
export interface BlockDetail {
  id: string;
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  pattern: BlockPattern | null;
  groupId: string | null;
  /** [] = all services. Otherwise the services it stops, by id. */
  serviceIds: string[];
  /** Those services' names, in the shop's order; a deleted one is left out. */
  services: { id: string; name: string }[];
  /** "All services", or "Shape-up and Kids' cut only". */
  scopeLabel: string;
  group: {
    /** Rows "the whole group" acts on: not yet over, plus this one. */
    count: number;
    staff: { id: string; name: string }[];
    /** Shop-local days the group still covers, ascending. */
    days: string[];
    /** Whether a new time of day can be applied to every row at once. */
    timesEditable: boolean;
  };
}

/**
 * True when every row sits inside ONE shop-local day (it starts and ends on
 * the same day, or ends exactly at the next midnight): only then does "the
 * same new hours on each day" mean something. A continuous absence's rows do
 * not qualify - its first and last days are partial on purpose.
 */
function rowsAreDayShaped(
  rows: { startsAt: Date; endsAt: Date; pattern: string | null }[],
  timezone: string,
): boolean {
  if (rows.some((r) => r.pattern === "continuous")) return false;
  return rows.every((r) => {
    const key = zonedDateKey(r.startsAt, timezone);
    const p = parseDayKey(key)!;
    const [whole] = daySpans(p, p, timezone);
    return r.endsAt.getTime() <= whole!.endsAt.getTime();
  });
}

/** The rows "the whole group" acts on: still to come, plus the one tapped. */
async function groupRows(
  tx: Prisma.TransactionClient,
  shopId: string,
  target: { id: string; groupId: string | null },
  now: Date,
) {
  const select = {
    id: true,
    staffId: true,
    startsAt: true,
    endsAt: true,
    reason: true,
    pattern: true,
    groupId: true,
    serviceIds: true,
  } as const;
  if (!target.groupId) {
    return tx.availabilityException.findMany({
      where: { id: target.id, shopId, isBlock: true },
      select,
    });
  }
  return tx.availabilityException.findMany({
    where: {
      shopId,
      isBlock: true,
      OR: [{ id: target.id }, { groupId: target.groupId, endsAt: { gt: now } }],
    },
    orderBy: [{ startsAt: "asc" }, { staffId: "asc" }],
    select,
  });
}

export async function readBlock(input: {
  shopId: string;
  timezone: string;
  id: string;
  now: Date;
}): Promise<BlockDetail | null> {
  return runWithShop(input.shopId, async (tx) => {
    const target = await tx.availabilityException.findFirst({
      where: { id: input.id, shopId: input.shopId, isBlock: true },
      select: {
        id: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        reason: true,
        pattern: true,
        groupId: true,
        serviceIds: true,
      },
    });
    if (!target) return null;
    const rows = await groupRows(tx, input.shopId, target, input.now);
    const scopedServices =
      target.serviceIds.length === 0
        ? []
        : await tx.service.findMany({
            where: { shopId: input.shopId, id: { in: target.serviceIds } },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            select: { id: true, name: true },
          });
    const serviceName = new Map(scopedServices.map((s) => [s.id, s.name]));
    const staffIds = [...new Set(rows.map((r) => r.staffId))];
    const staff = await tx.staff.findMany({
      where: { shopId: input.shopId, id: { in: staffIds } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const names = new Map(staff.map((s) => [s.id, s.name]));
    const days = [...new Set(rows.map((r) => zonedDateKey(r.startsAt, input.timezone)))].sort();
    return {
      id: target.id,
      staffId: target.staffId,
      staffName: names.get(target.staffId) ?? "Provider",
      startsAt: target.startsAt.toISOString(),
      endsAt: target.endsAt.toISOString(),
      reason: target.reason,
      pattern: (target.pattern as BlockPattern | null) ?? null,
      groupId: target.groupId,
      serviceIds: target.serviceIds,
      services: scopedServices,
      scopeLabel: describeBlockScope(target.serviceIds, (id) => serviceName.get(id)),
      group: {
        count: rows.length,
        staff: staff.map((s) => ({ id: s.id, name: s.name })),
        days,
        timesEditable: rowsAreDayShaped(rows, input.timezone),
      },
    };
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2002") return true;
  return err.code === "P2010" && (err.meta as { code?: string } | undefined)?.code === "23505";
}

export type EditTiming =
  /** "This block": a new day and hours (or all day). */
  | { kind: "day"; date: string; window?: DayWindow }
  /** "The whole group": these hours (or all day) on each row's own day. */
  | { kind: "window"; window?: DayWindow };

export type EditBlockOutcome =
  | { kind: "not_found" }
  | { kind: "bad_services"; message: string }
  | { kind: "invalid"; field: string; message: string }
  | { kind: "conflict"; conflicts: StaffConflictRow[]; confirmation: string; manyStaff: boolean }
  | { kind: "duplicate" }
  | { kind: "updated"; count: number; overlapping: number };

/**
 * Change a block (or its whole group). A new time re-runs the same conflict
 * check a save does, under every affected chair's lock, and is refused over
 * bookings unless the barber confirms exactly them. A note-only edit moves no
 * time and checks nothing. Rows are updated in place: ids, group and request
 * id stay, so an open sheet and a retried save still find them.
 */
export async function editBlock(input: {
  shopId: string;
  timezone: string;
  id: string;
  scope: "one" | "group";
  /** undefined = leave the note; null/"" = clear it. */
  reason: string | null | undefined;
  timing: EditTiming | undefined;
  /**
   * undefined = leave which services it stops; [] = all services (the whole
   * chair); a list = only those. Applied to every row the edit covers.
   */
  serviceIds?: readonly string[];
  confirmation: string | null;
  now: Date;
}): Promise<EditBlockOutcome> {
  const nextServiceIds =
    input.serviceIds === undefined ? undefined : [...new Set(input.serviceIds)].sort();
  if (nextServiceIds && nextServiceIds.length > MAX_BLOCK_SERVICES) {
    return { kind: "bad_services", message: `Pick up to ${MAX_BLOCK_SERVICES} services.` };
  }
  try {
    return await runWithShop(
      input.shopId,
      async (tx): Promise<EditBlockOutcome> => {
        const target = await tx.availabilityException.findFirst({
          where: { id: input.id, shopId: input.shopId, isBlock: true },
          select: { id: true, groupId: true, staffId: true },
        });
        if (!target) return { kind: "not_found" };
        const scoped = input.scope === "group" ? target : { ...target, groupId: null };
        const before = await groupRows(tx, input.shopId, scoped, input.now);
        await lockStaffCalendars(
          tx,
          before.map((r) => r.staffId),
        );
        // Read again under the locks: what is edited is what is there now.
        const rows = await groupRows(tx, input.shopId, scoped, input.now);
        if (!rows.some((r) => r.id === target.id)) return { kind: "not_found" };

        let next: { id: string; staffId: string; startsAt: Date; endsAt: Date }[] | null = null;
        if (input.timing?.kind === "day") {
          if (input.scope === "group") {
            return { kind: "invalid", field: "timing", message: "Pick new hours for the group, not a date." };
          }
          const plan = planBlock(
            { kind: "day", date: input.timing.date, window: input.timing.window },
            input.timezone,
            input.now,
          );
          if (!plan.ok) return { kind: "invalid", field: plan.field, message: plan.message };
          const row = rows[0]!;
          next = [{ id: row.id, staffId: row.staffId, ...plan.spans[0]! }];
        } else if (input.timing?.kind === "window") {
          if (!rowsAreDayShaped(rows, input.timezone)) {
            return {
              kind: "invalid",
              field: "timing",
              message:
                "This block runs across days. Change one day at a time, or remove it and block the time again.",
            };
          }
          const w = input.timing.window;
          if (w && (w.fromMin < 0 || w.fromMin >= 24 * 60 || w.toMin > 24 * 60 || w.toMin <= w.fromMin)) {
            return { kind: "invalid", field: "toMin", message: "The end time must be after the start time." };
          }
          next = rows.map((r) => {
            const p = parseDayKey(zonedDateKey(r.startsAt, input.timezone))!;
            const [s] = daySpans(p, p, input.timezone, w);
            return { id: r.id, staffId: r.staffId, startsAt: s!.startsAt, endsAt: s!.endsAt };
          });
        }

        // A new scope is checked like a new time: widening "Shape-ups only" to
        // every service (or adding one) can put bookings in the way that were
        // not before. Narrowing it can only take bookings OUT of the way.
        if (nextServiceIds) {
          const staffIds = [...new Set(rows.map((r) => r.staffId))];
          if ((await unknownBlockServices(tx, input.shopId, staffIds, nextServiceIds)).length > 0) {
            return { kind: "bad_services", message: UNKNOWN_SERVICES_MESSAGE };
          }
          if (!next) {
            next = rows.map((r) => ({
              id: r.id,
              staffId: r.staffId,
              startsAt: r.startsAt,
              endsAt: r.endsAt,
            }));
          }
        }
        const scope = nextServiceIds ?? rows[0]!.serviceIds;

        let overlapping = 0;
        if (next) {
          const staffIds = [...new Set(next.map((n) => n.staffId))];
          const staff = await tx.staff.findMany({
            where: { shopId: input.shopId, id: { in: staffIds } },
            select: { id: true, name: true },
          });
          const names = new Map(staff.map((s) => [s.id, s.name]));
          const byStaff = new Map<string, PlannedSpan[]>();
          for (const n of next) byStaff.set(n.staffId, [...(byStaff.get(n.staffId) ?? []), n]);
          const conflicts = await conflictsFor(tx, input.shopId, byStaff, names, input.now, scope);
          if (conflicts.length > 0) {
            const confirmation = blockOverAppointmentsConfirmation(conflicts);
            if (input.confirmation !== confirmation) {
              return {
                kind: "conflict",
                conflicts,
                confirmation,
                manyStaff: staffIds.length > 1,
              };
            }
          }
          overlapping = conflicts.length;
          // One statement for the whole group (a year of daily rows is a few
          // hundred), ISO text + ::timestamp like every raw write here (#70).
          await tx.$executeRaw(
            Prisma.sql`UPDATE "AvailabilityException" AS e
                       SET "startsAt" = v.s, "endsAt" = v.e, "updatedAt" = now()
                       FROM (SELECT unnest(${next.map((n) => n.id)}::text[]) AS id,
                                    unnest(${next.map((n) => n.startsAt.toISOString())}::timestamp[]) AS s,
                                    unnest(${next.map((n) => n.endsAt.toISOString())}::timestamp[]) AS e) AS v
                       WHERE e.id = v.id AND e."shopId" = ${input.shopId} AND e."isBlock" = true`,
          );
        }
        if (nextServiceIds) {
          await tx.availabilityException.updateMany({
            where: { shopId: input.shopId, isBlock: true, id: { in: rows.map((r) => r.id) } },
            data: { serviceIds: nextServiceIds },
          });
        }
        if (input.reason !== undefined) {
          await tx.availabilityException.updateMany({
            where: { shopId: input.shopId, isBlock: true, id: { in: rows.map((r) => r.id) } },
            data: { reason: input.reason || null },
          });
        }
        return { kind: "updated", count: rows.length, overlapping };
      },
      TX_OPTS,
    );
  } catch (err) {
    // Moved onto the start of a sibling from the same save: that time is
    // already blocked by it. The move is a raw UPDATE, so the unique index
    // surfaces as P2010 carrying Postgres' 23505 rather than as P2002.
    if (isUniqueViolation(err)) return { kind: "duplicate" };
    throw err;
  }
}

/**
 * Remove a block, or its whole group (the rows still to come, plus the one
 * tapped). Only BLOCKS: a one-off open window (isBlock:false) shares the
 * table and is never removed here, whatever id is passed. Nothing else is
 * touched - the freed time is bookable again only where no other block,
 * weekly break or booking still holds it, because the grid is computed from
 * whatever rows remain.
 */
export async function removeBlocks(input: {
  shopId: string;
  id: string;
  scope: "one" | "group";
  now: Date;
}): Promise<{ removed: number }> {
  return runWithShop(input.shopId, async (tx) => {
    const target = await tx.availabilityException.findFirst({
      where: { id: input.id, shopId: input.shopId, isBlock: true },
      select: { id: true, groupId: true },
    });
    if (!target) return { removed: 0 };
    const where =
      input.scope === "group" && target.groupId
        ? {
            shopId: input.shopId,
            isBlock: true,
            OR: [{ id: target.id }, { groupId: target.groupId, endsAt: { gt: input.now } }],
          }
        : { shopId: input.shopId, isBlock: true, id: target.id };
    const { count } = await tx.availabilityException.deleteMany({ where });
    return { removed: count };
  });
}
