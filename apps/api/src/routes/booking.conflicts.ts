import { Router } from "express";
import { z } from "zod";
import { prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { logger } from "../logger.js";

/**
 * THE MANAGER'S CONFLICT INBOX - the reader the P0 deliberately did not build.
 *
 * The booking-integrity work made a double-booked chair DURABLE: a walk-in
 * receipt that lands over an existing booking is recorded rather than refused,
 * and the collision becomes a BookingConflict row. Until now the only way to
 * see one was the amber panel on the screen of whoever logged the walk-in, plus
 * a best-effort push. Miss both - no registered device, a barber who has gone
 * home, a manager who was not in the room - and the row sat in a table nobody
 * could open.
 *
 * 🔴 THIS SURFACE CHANGES NO BOOKING. It lists collisions and records that a
 * human dealt with one. It cannot cancel, move, reschedule or refund anything,
 * and it never deletes a row: resolving is bookkeeping, and the history of a
 * chair that was double-booked has to survive somebody tidying the list.
 *
 * Its own router file, deliberately, for the reason walkIn.dashboard.ts gives:
 * the open Square stack edits booking.dashboard.ts, and this is not booking
 * config.
 *
 * MANAGER ONLY (requireManager = OWNER | MANAGER), same as the rest of the
 * booking dashboard - a barber seat never reaches it.
 */
export const bookingConflictsRouter: Router = Router();

bookingConflictsRouter.use(requireUser, requireShop, requireManager);

/** Never more than this in one page, whatever the client asks for. */
const MAX_LIMIT = 50;

const listSchema = z.object({
  /** Default "open": the inbox is a to-do list, not an archive. */
  status: z.enum(["open", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  /**
   * Keyset cursor, not an offset: rows arrive while a manager is reading, and
   * an offset would silently skip or repeat one across pages.
   *
   * 🔴 BOTH PARTS ARE NOT NULL (`detectedAt` defaults now(), `id` is the PK).
   * A nullable keyset column is how the waitlist queue lost its tail.
   */
  cursor: z
    .preprocess(
      // Arrives as a JSON string on the query string; Express does not parse
      // it, and a malformed one must be a 400 rather than a 500.
      (v) => {
        if (typeof v !== "string" || v.length === 0) return v;
        try {
          return JSON.parse(v) as unknown;
        } catch {
          return "malformed";
        }
      },
      z.object({ detectedAt: z.string().datetime(), id: z.string().min(1) }),
    )
    .nullish(),
});

const resolveSchema = z.object({
  /** Short on purpose: a note for the next reader, not a case file. */
  note: z.string().trim().max(280).optional(),
});

const resolveAllSchema = z.object({
  /**
   * The `asOf` the manager's list came back with. Only conflicts detected at
   * or before it are touched: one that lands while the confirmation is open
   * was never on the screen, and "resolve all" must not tick it off unseen.
   */
  asOf: z.string().datetime(),
  /** The open count the manager was shown - see MORE THAN WAS SHOWN below. */
  expected: z.number().int().min(1).max(100_000),
  note: z.string().trim().max(280).optional(),
});

/** Thrown inside the transaction purely to roll it back. */
class MoreThanShown extends Error {}

/** The shape the inbox renders. Safe fields only - see the enrichment note. */
interface ConflictView {
  id: string;
  kind: "appointment" | "visit" | "block" | string;
  staffId: string;
  staffName: string | null;
  overlapStart: string;
  overlapEnd: string;
  detectedAt: string;
  source: string;
  receipt: ContextView;
  conflicting: ContextView;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

/**
 * What the inbox says about one of the two records.
 *
 * 🔴 NO CUSTOMER INFORMATION. Not the name, not the phone, not the price. A
 * manager resolving a conflict opens the two bookings on the calendar; this
 * exists to point at them, and copying customer data into a second surface
 * would only widen where it can leak. `exists: false` is a real, expected
 * state - a booking can be deleted after the conflict was recorded, and the
 * row must still render.
 */
interface ContextView {
  id: string;
  exists: boolean;
  startsAt: string | null;
  endsAt: string | null;
  status: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Look up the two referenced records so the inbox can show what they are and
 * link to the ones that still exist.
 *
 * Batched: one query per kind for the whole page, rather than two per row.
 * Everything is shop-scoped, so a crafted id from another tenant resolves to
 * `exists: false` rather than leaking that it exists somewhere.
 */
async function loadContext(
  shopId: string,
  refs: { id: string; kind: string }[],
): Promise<Map<string, ContextView>> {
  const byKind = (k: string) => refs.filter((r) => r.kind === k).map((r) => r.id);
  const apptIds = byKind("appointment");
  const visitIds = byKind("visit");
  const blockIds = byKind("block");

  const [appts, visits, blocks] = await runWithShop(shopId, async (tx) =>
    Promise.all([
      apptIds.length
        ? tx.appointment.findMany({
            where: { id: { in: apptIds }, shopId },
            select: { id: true, startsAt: true, endsAt: true, status: true },
          })
        : [],
      visitIds.length
        ? tx.visit.findMany({
            where: { id: { in: visitIds }, shopId },
            select: { id: true, scheduledAt: true, endAt: true, status: true },
          })
        : [],
      blockIds.length
        ? tx.externalBlock.findMany({
            where: { id: { in: blockIds }, shopId },
            select: { id: true, startsAt: true, endsAt: true },
          })
        : [],
    ]),
  );

  const out = new Map<string, ContextView>();
  for (const a of appts) {
    out.set(a.id, {
      id: a.id,
      exists: true,
      startsAt: iso(a.startsAt),
      endsAt: iso(a.endsAt),
      status: a.status,
    });
  }
  for (const v of visits) {
    out.set(v.id, {
      id: v.id,
      exists: true,
      startsAt: iso(v.scheduledAt),
      // Nullable on purpose across the booking domain; the inbox shows it as
      // unknown rather than inventing an end.
      endsAt: iso(v.endAt),
      status: v.status,
    });
  }
  for (const b of blocks) {
    out.set(b.id, {
      id: b.id,
      exists: true,
      startsAt: iso(b.startsAt),
      endsAt: iso(b.endsAt),
      status: "BLOCK",
    });
  }
  return out;
}

/**
 * GET / - the inbox.
 *
 * Newest first, keyset-paginated, with the unresolved count for the badge. The
 * count is ALWAYS the open count regardless of the status filter: it drives a
 * "you have N to deal with" badge, and that number must not change because
 * somebody switched the list to "resolved".
 */
bookingConflictsRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  // Taken BEFORE the read, so everything detected up to it had its chance to
  // be counted. Handed back for "resolve all" to bound itself by.
  const asOf = new Date();
  const parsed = listSchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { status, limit } = parsed.data;
  const cursor = parsed.data.cursor ?? null;

  const where = {
    shopId,
    ...(status === "open" ? { resolvedAt: null } : {}),
    ...(status === "resolved" ? { resolvedAt: { not: null } } : {}),
    // Strictly BEFORE the cursor in (detectedAt desc, id desc) order. The id
    // tiebreak matters: several conflicts from one walk-in share a timestamp.
    ...(cursor
      ? {
          OR: [
            { detectedAt: { lt: new Date(cursor.detectedAt) } },
            { detectedAt: new Date(cursor.detectedAt), id: { lt: cursor.id } },
          ],
        }
      : {}),
  };

  const [rows, unresolvedCount] = await runWithShop(shopId, async (tx) =>
    Promise.all([
      tx.bookingConflict.findMany({
        where,
        orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
        // One extra row answers "is there another page" without a second count.
        take: limit + 1,
      }),
      tx.bookingConflict.count({ where: { shopId, resolvedAt: null } }),
    ]),
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? { detectedAt: last.detectedAt.toISOString(), id: last.id }
      : null;

  // Names for the chairs and the people who resolved things. Staff is
  // shop-scoped; User is not a tenant table, so it is read directly and only
  // for the ids this page actually references.
  const staffIds = [...new Set(page.map((r) => r.staffId))];
  const resolverIds = [...new Set(page.map((r) => r.resolvedByUserId).filter((v): v is string => !!v))];
  const [staff, resolvers, context] = await Promise.all([
    staffIds.length
      ? runWithShop(shopId, (tx) =>
          tx.staff.findMany({ where: { id: { in: staffIds }, shopId }, select: { id: true, name: true } }),
        )
      : Promise.resolve([]),
    resolverIds.length
      ? prisma.user.findMany({ where: { id: { in: resolverIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    loadContext(
      shopId,
      page.flatMap((r) => [
        { id: r.receiptId, kind: "appointment" },
        { id: r.conflictingId, kind: r.conflictingKind },
      ]),
    ),
  ]);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const resolverName = new Map(resolvers.map((u) => [u.id, u.name]));

  const missing = (id: string): ContextView => ({
    id,
    exists: false,
    startsAt: null,
    endsAt: null,
    status: null,
  });

  const items: ConflictView[] = page.map((r) => ({
    id: r.id,
    kind: r.conflictingKind,
    staffId: r.staffId,
    staffName: staffName.get(r.staffId) ?? null,
    overlapStart: r.overlapStart.toISOString(),
    overlapEnd: r.overlapEnd.toISOString(),
    detectedAt: r.detectedAt.toISOString(),
    source: r.source,
    receipt: context.get(r.receiptId) ?? missing(r.receiptId),
    conflicting: context.get(r.conflictingId) ?? missing(r.conflictingId),
    resolvedAt: iso(r.resolvedAt),
    resolvedByName: r.resolvedByUserId ? (resolverName.get(r.resolvedByUserId) ?? null) : null,
    resolutionNote: r.resolutionNote,
  }));

  res.json({ items, nextCursor, unresolvedCount, asOf: asOf.toISOString() });
});

/**
 * POST /resolve-all - the manager has dealt with every one on the list.
 *
 * Exists because the list is worked one tap and one confirmation at a time,
 * and a shop that has already rung everybody should not have to do that
 * sixteen times. The same rules as a single resolve, applied to the batch:
 *
 * 🔴 CHANGES NOTHING ABOUT ANY BOOKING. Three fields on each conflict row,
 * nothing else - no cancel, no move, no refund, no message to anyone.
 *
 * 🔴 FIRST WRITER STILL WINS. Only rows that are still open are touched, so a
 * conflict a teammate already resolved keeps THEIR name and note.
 *
 * 🔴 NEVER MORE THAN WAS SHOWN. Bounded by `asOf`, and then checked against
 * the count the manager confirmed: if the update would touch MORE rows than
 * that, it is rolled back and refused. The bound alone leaves a gap - a
 * conflict stamped just before `asOf` whose transaction committed after the
 * list was read - and the count closes it. FEWER is fine (a teammate got to
 * some first); the manager asked for all of them to be dealt with, and they
 * are.
 */
bookingConflictsRouter.post("/resolve-all", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const parsed = resolveAllSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const now = new Date();
  // Never later than now: a client clock running ahead must not widen it.
  const asOf = new Date(Math.min(new Date(parsed.data.asOf).getTime(), now.getTime()));
  const note = parsed.data.note?.length ? parsed.data.note : null;

  let resolved: number;
  try {
    resolved = await runWithShop(shopId, async (tx) => {
      const { count } = await tx.bookingConflict.updateMany({
        where: { shopId, resolvedAt: null, detectedAt: { lte: asOf } },
        data: { resolvedAt: now, resolvedByUserId: userId, resolutionNote: note },
      });
      if (count > parsed.data.expected) throw new MoreThanShown();
      return count;
    });
  } catch (err) {
    if (err instanceof MoreThanShown) {
      // Nothing was written. The UI reloads and asks again with the real count.
      res.status(409).json({ error: "conflicts_changed" });
      return;
    }
    throw err;
  }

  if (resolved > 0) {
    logger.info(
      { shopId, userId, resolved },
      "booking conflicts marked resolved in bulk (no booking was changed)",
    );
  }
  res.json({ ok: true, resolved });
});

/**
 * POST /:id/resolve - a human has dealt with this one.
 *
 * 🔴 CHANGES NOTHING ABOUT EITHER BOOKING. It writes three fields on the
 * conflict row and stops. Both appointments stay exactly as they were; nothing
 * is cancelled, moved or refunded.
 *
 * 🔴 FIRST WRITER WINS, and says so. Two managers working the list at once, or
 * one double-tapping, must not have the second silently overwrite the first's
 * name and note - the audit trail is the whole point. The update is conditional
 * on the row still being open, and a resolve that lands second returns 200 with
 * the EXISTING resolution rather than an error: the work is done either way,
 * and an error would invite a retry that achieves nothing.
 */
bookingConflictsRouter.post("/:id/resolve", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const conflictId = String(req.params.id ?? "");
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const note = parsed.data.note?.length ? parsed.data.note : null;

  const outcome = await runWithShop(shopId, async (tx) => {
    const existing = await tx.bookingConflict.findFirst({
      where: { id: conflictId, shopId },
      select: { id: true, resolvedAt: true, resolvedByUserId: true, resolutionNote: true },
    });
    if (!existing) return { kind: "not_found" as const };

    // Conditional on still being open. updateMany (not update) so the WHERE is
    // part of the statement: count 0 means somebody else got there first.
    const { count } = await tx.bookingConflict.updateMany({
      where: { id: conflictId, shopId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedByUserId: userId, resolutionNote: note },
    });
    if (count === 0) {
      return { kind: "already" as const, row: existing };
    }
    const row = await tx.bookingConflict.findFirstOrThrow({
      where: { id: conflictId, shopId },
      select: { id: true, resolvedAt: true, resolvedByUserId: true, resolutionNote: true },
    });
    return { kind: "resolved" as const, row };
  });

  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (outcome.kind === "resolved") {
    logger.info(
      { shopId, conflictId, userId },
      "booking conflict marked resolved (no booking was changed)",
    );
  }
  const resolver = outcome.row.resolvedByUserId
    ? await prisma.user.findUnique({
        where: { id: outcome.row.resolvedByUserId },
        select: { name: true },
      })
    : null;
  res.json({
    ok: true,
    // `false` tells the UI "somebody else had already done this", so it can say
    // so instead of pretending this click was the one that counted.
    changed: outcome.kind === "resolved",
    id: outcome.row.id,
    resolvedAt: iso(outcome.row.resolvedAt),
    resolvedByName: resolver?.name ?? null,
    resolutionNote: outcome.row.resolutionNote,
  });
});
