import { z } from "zod";
import { runWithShop } from "@chairback/db";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";
import { initialOnly } from "./shopTime.js";

/**
 * The client book, read-only and deliberately thin.
 *
 * ── 🔴 THE ONE DECISION IN THIS FILE ─────────────────────────────────────────
 *
 * This is the most sensitive data ChairBack holds, and it is the tool most
 * likely to be asked for by name. So: NO PHONE NUMBER, NO EMAIL, NO ADDRESS,
 * NO BARBER'S PRIVATE NOTES, ever, on either tool here. What comes back is a
 * first name, a last initial, and BUSINESS FACTS — how often they come, what
 * they last had, what they are worth, whether they are due.
 *
 * The reasoning is the same as the calendar's but with more at stake. A barber
 * asking "who haven't I seen in a while" is asking a business question, and the
 * business answer needs no contact details. The moment the assistant can read a
 * phone number, a leaked transcript is a leaked customer list — and the shop,
 * not ChairBack, is the data controller who has to answer for it.
 *
 * 🔑 A barber who wants the contact details still has them: they are one tap
 * away in the dashboard, which is the surface where looking at your own client
 * is an ordinary act rather than a copy into somebody else's model context.
 * This tool is not the only route to the data, so making it the narrow one
 * costs the barber nothing.
 *
 * ── WHY THESE STAY AVAILABLE ON A LAPSED SHOP ────────────────────────────────
 *
 * `isOwnDataRead` in middleware/wallExemptions.ts already keeps GET access to
 * the client book open when a shop lapses, because locking a barber out of
 * their own customer list reads as holding data hostage. These two tools mirror
 * that hole exactly — they are the read, not the product working.
 */

const MAX_RESULTS = 40;

const searchSchema = z
  .object({
    query: z.string().min(1).max(80).optional(),
    /** "due" = past their usual gap. The question this tool is really for. */
    filter: z.enum(["all", "due", "lapsed", "top"]).optional(),
  })
  .strict();

/** Fields every client answer is built from. Nothing here identifies a person. */
const CLIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  lastVisitAt: true,
  nextExpectedAt: true,
  medianIntervalDays: true,
  loyaltyTier: true,
  optedOut: true,
} as const;

function summary(
  c: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    lastVisitAt: Date | null;
    nextExpectedAt: Date | null;
    medianIntervalDays: number | null;
    loyaltyTier: string | null;
    optedOut: boolean;
  },
  now: Date,
) {
  const daysSince =
    c.lastVisitAt === null
      ? null
      : Math.floor((now.getTime() - c.lastVisitAt.getTime()) / 86_400_000);
  return {
    id: c.id,
    name: initialOnly(c.firstName, c.lastName),
    lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
    daysSinceLastVisit: daysSince,
    typicalGapDays: c.medianIntervalDays,
    dueAt: c.nextExpectedAt?.toISOString() ?? null,
    overdue: c.nextExpectedAt !== null && c.nextExpectedAt.getTime() < now.getTime(),
    loyaltyTier: c.loyaltyTier,
    // Load-bearing for the assistant: it must not suggest texting someone who
    // opted out, and it can only avoid that if it is told.
    optedOutOfTexts: c.optedOut,
  };
}

async function search(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = searchSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;
  const { query, filter = "all" } = parsed.data;

  // Archived clients stay hidden, exactly as every non-archived dashboard
  // filter hides them.
  const where: Record<string, unknown> = {
    shopId: inv.shopId,
    archivedAt: null,
  };

  if (query) {
    // A plain contains-search on the NAME columns only. The dashboard's trigram
    // ranking is better for a human scanning a list; it is also a raw query
    // that interpolates the term, and this input arrives from a language model.
    // A parameterised Prisma filter over two columns is the right trade here.
    where.OR = [
      { firstName: { contains: query, mode: "insensitive" } },
      { lastName: { contains: query, mode: "insensitive" } },
    ];
  }

  if (filter === "due" || filter === "lapsed") {
    where.nextExpectedAt = { not: null, lt: inv.now };
  }

  // 🔴 runWithShop, not forShop. The facade's findMany is typed as the FULL
  // row regardless of `select`, so `c.phone` would compile here and silently be
  // undefined at runtime. On the one file whose entire point is that contact
  // details never leave, the type must agree with the select - here, reaching
  // for an unselected field is a compile error.
  const rows = await runWithShop(inv.shopId, (tx) =>
    tx.client.findMany({
      where,
      orderBy:
        filter === "top"
          ? [{ loyaltyTier: "desc" }, { lastVisitAt: "desc" }]
          : [{ lastVisitAt: "desc" }],
      take: MAX_RESULTS + 1,
      select: CLIENT_SELECT,
    }),
  );

  const truncated = rows.length > MAX_RESULTS;
  return {
    ok: true,
    resource: { type: "clients", id: null },
    data: {
      filter,
      truncated,
      clients: (truncated ? rows.slice(0, MAX_RESULTS) : rows).map((c) => summary(c, inv.now)),
    },
  };
}

const detailSchema = z.object({ clientId: z.string().min(1).max(40) }).strict();

const MAX_VISITS = 20;

async function detail(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = detailSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  // 🔴 shopId in the WHERE as well as RLS. Defense in depth, and the same
  // pattern the rest of the app follows: a client id from a model is a filter
  // inside this shop, never a lookup across shops.
  const client = await runWithShop(inv.shopId, (tx) =>
    tx.client.findFirst({
      where: { id: parsed.data.clientId, shopId: inv.shopId, archivedAt: null },
      select: CLIENT_SELECT,
    }),
  );

  if (!client) {
    return {
      ok: false,
      code: "no_such_client",
      message: "There's no client by that id at this shop.",
    };
  }

  const visits = await runWithShop(inv.shopId, (tx) =>
    tx.visit.findMany({
      where: { shopId: inv.shopId, clientId: client.id },
      orderBy: { scheduledAt: "desc" },
      take: MAX_VISITS,
      select: {
        id: true,
        scheduledAt: true,
        status: true,
        serviceName: true,
        price: true,
      },
    }),
  );

  return {
    ok: true,
    resource: { type: "client", id: client.id },
    data: {
      client: summary(client, inv.now),
      visits: visits.map((v) => ({
        id: v.id,
        at: v.scheduledAt.toISOString(),
        status: v.status,
        service: v.serviceName,
        // Decimal -> number at the edge. A Prisma Decimal serialises to an
        // object, and a model reading {"s":1,"e":1,"d":[45]} learns nothing.
        price: v.price === null ? null : Number(v.price),
      })),
    },
  };
}

export const clientTools: ToolDefinition[] = [
  {
    name: "clients_search",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name to search for.",
          maxLength: 80,
        },
        filter: {
          type: "string",
          enum: ["all", "due", "lapsed", "top"],
          description: "'due'/'lapsed' = past their usual gap. 'top' = best loyalty standing.",
        },
      },
      additionalProperties: false,
    },
    handler: search,
  },
  {
    name: "client_detail",
    inputSchema: {
      type: "object",
      properties: {
        clientId: {
          type: "string",
          description: "A client id from clients_search.",
        },
      },
      required: ["clientId"],
      additionalProperties: false,
    },
    handler: detail,
  },
];
