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
 * Who is waiting.
 *
 * 🔴 SAME PII FLOOR AS THE CALENDAR: first name and last initial, never a phone
 * number or an email, and never the client's freeform `note`. The note is
 * whatever the customer typed into a public form — it is the single least
 * predictable field in the schema and the one most likely to contain something
 * the shop would not choose to send to a model provider.
 *
 * `preferredTime` IS returned: it is the answer to "who wants Saturday
 * morning", which is the question this tool exists for.
 */

const MAX_ENTRIES = 200;

/** Non-empty, de-duplicated ids. `staffId` stores "" for "any chair". */
const ids = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

const schema = z
  .object({
    /** Default WAITING — the only status a barber usually means. */
    status: z.enum(["WAITING", "OFFERED", "BOOKED", "EXPIRED", "CANCELED", "ALL"]).optional(),
  })
  .strict();

async function list(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = schema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;
  const status = parsed.data.status ?? "WAITING";

  // One transaction for all three reads. See the note in clients.ts on why the
  // real tx client is used rather than the forShop facade.
  const { rows, services, chairs } = await runWithShop(inv.shopId, async (tx) => {
    const rows = await tx.waitlistEntry.findMany({
      where: {
        shopId: inv.shopId,
        ...(status === "ALL" ? {} : { status }),
      },
      // Tier first, then age — the same order the queue itself is served in, so
      // the assistant's "who's next" matches what the barber sees.
      orderBy: [{ tierRank: "asc" }, { createdAt: "asc" }],
      take: MAX_ENTRIES + 1,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        tierRank: true,
        preferredTime: true,
        createdAt: true,
        staffId: true,
        serviceId: true,
      },
    });

    // WaitlistEntry stores ids, not relations, so the names are resolved in one
    // extra pair of reads rather than per row.
    const [services, chairs] = await Promise.all([
      tx.service.findMany({
        where: {
          shopId: inv.shopId,
          id: { in: ids(rows.map((r) => r.serviceId)) },
        },
        select: { id: true, name: true },
      }),
      tx.staff.findMany({
        where: {
          shopId: inv.shopId,
          id: { in: ids(rows.map((r) => r.staffId)) },
        },
        select: { id: true, name: true },
      }),
    ]);
    return { rows, services, chairs };
  });

  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const chairName = new Map(chairs.map((c) => [c.id, c.name]));

  const truncated = rows.length > MAX_ENTRIES;

  return {
    ok: true,
    resource: { type: "waitlist", id: null },
    data: {
      status,
      truncated,
      entries: (truncated ? rows.slice(0, MAX_ENTRIES) : rows).map((e) => ({
        id: e.id,
        client: initialOnly(e.firstName, e.lastName),
        status: e.status,
        tierRank: e.tierRank,
        wants: e.serviceId ? (serviceName.get(e.serviceId) ?? null) : null,
        // null/"" both mean "any chair" — normalised so a model does not have
        // to know that the column stores both.
        chair: e.staffId ? (chairName.get(e.staffId) ?? null) : null,
        anyChair: !e.staffId,
        preferredTime: e.preferredTime ?? null,
        waitingSince: e.createdAt.toISOString(),
      })),
    },
  };
}

export const waitlistTools: ToolDefinition[] = [
  {
    name: "waitlist_list",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["WAITING", "OFFERED", "BOOKED", "EXPIRED", "CANCELED", "ALL"],
          description: "Which entries to return. Defaults to WAITING.",
        },
      },
      additionalProperties: false,
    },
    handler: list,
  },
];
