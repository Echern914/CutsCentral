import { z } from "zod";
import { runWithShop } from "@chairback/db";
import { blockedRangesByStaff } from "../../engines/blockedTime.js";
import { computeOpenSlots } from "../../engines/slots.js";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";
import { initialOnly, shopClock, windowFor, ymdSchema } from "./shopTime.js";

/**
 * The calendar, read-only.
 *
 * ── 🔴 WHAT A MODEL IS AND IS NOT TOLD ABOUT A CUSTOMER ──────────────────────
 *
 * An appointment carries a first name, a last name, a phone number, an email
 * and the barber's private note about the booking. This tool returns the first
 * name and a last INITIAL, and nothing else about the person.
 *
 * That is not squeamishness. The other end of this pipe is a third-party model
 * provider under the customer's OWN account, which means every field here
 * leaves ChairBack's control the moment it is returned. "Ricky T. at 2:15, fade,
 * 45 minutes" is the entire useful content of the question a barber actually
 * asks. A phone number adds nothing to the answer and a great deal to the
 * consequences of the transcript leaking.
 *
 * `notes` is excluded for the same reason and one more: it is explicitly the
 * barber's private note about a booking ("comping the beard"), and the schema
 * comment says it must never leak into the client's permanent record — leaking
 * it to a model instead is not an improvement.
 *
 * ── CHAIR SCOPING ────────────────────────────────────────────────────────────
 *
 * `inv.chairFilterStaffId` is applied to every query, and there is deliberately
 * NO staffId argument on these tools. An employee asking about the calendar gets
 * their own chair because the policy decided so before the handler ran; there is
 * no parameter for them to change.
 */

/** A day either side, so a query is never quietly empty at the boundary. */
const MAX_WINDOW_DAYS = 62;
const MAX_APPOINTMENTS = 300;

const agendaSchema = z
  .object({
    from: ymdSchema,
    to: ymdSchema.optional(),
  })
  .strict();

/** Statuses that no longer occupy the chair, mirroring the barber router. */
const CLOSED = new Set(["CANCELED", "NO_SHOW"]);

async function agenda(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = agendaSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  const clock = await shopClock(inv.shopId);
  if (!clock) {
    return {
      ok: false,
      code: "shop_not_found",
      message: "That shop is no longer available.",
    };
  }

  const window = windowFor(
    parsed.data.from,
    parsed.data.to ?? parsed.data.from,
    clock,
    MAX_WINDOW_DAYS,
  );
  if (!window) {
    return {
      ok: false,
      code: "window_too_wide",
      message: `Ask for a range of ${MAX_WINDOW_DAYS} days or fewer.`,
    };
  }

  // `undefined` is how Prisma spells "no filter". Written this way rather than
  // as a spread because a spread of a union widens the argument type and TS
  // silently drops the `select` inference with it - the relations then come
  // back untyped and the whole point of selecting narrow fields is lost.
  const staffFilter = inv.chairFilterStaffId ?? undefined;

  // ONE shop-scoped transaction, not two. Every forShop() call is its own
  // BEGIN + SET ROLE + query + COMMIT, and the agenda handler learned the hard
  // way that stacking those is what "the calendar is slow" is made of.
  const { appointments, chairs } = await runWithShop(inv.shopId, async (tx) => {
    const [appointments, chairs] = await Promise.all([
      tx.appointment.findMany({
        where: {
          shopId: inv.shopId,
          staffId: staffFilter,
          startsAt: { lt: window.to },
          endsAt: { gt: window.from },
        },
        orderBy: { startsAt: "asc" },
        // One more than the cap, so "there is more" is known rather than guessed.
        take: MAX_APPOINTMENTS + 1,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          firstName: true,
          lastName: true,
          staffId: true,
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
      }),
      tx.staff.findMany({
        where: { shopId: inv.shopId, id: staffFilter },
        select: { id: true, name: true, active: true },
      }),
    ]);
    return { appointments, chairs };
  });

  const truncated = appointments.length > MAX_APPOINTMENTS;
  const rows = truncated ? appointments.slice(0, MAX_APPOINTMENTS) : appointments;

  // Blocked time comes from the one engine that already reconciles all three
  // sources (one-off exceptions, standing weekly blocks, and time blocked in
  // Acuity). Re-deriving it here would be a fourth answer to a question that
  // has caused enough trouble with three.
  const blocks = await blockedRangesByStaff({
    shopId: inv.shopId,
    staffIds: chairs.map((c) => c.id),
    fromMs: window.from.getTime(),
    toMs: window.to.getTime(),
    timezone: clock.timezone,
  });

  return {
    ok: true,
    resource: { type: "agenda", id: null },
    data: {
      timezone: clock.timezone,
      from: parsed.data.from,
      to: parsed.data.to ?? parsed.data.from,
      scope: inv.chairFilterStaffId ? "chair" : "shop",
      // 🔴 Reported, never hidden. A truncated calendar that looks complete is
      // how an assistant confidently tells a barber their afternoon is free.
      truncated,
      appointments: rows.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        status: a.status,
        occupiesChair: !CLOSED.has(a.status),
        client: initialOnly(a.firstName, a.lastName),
        service: a.service?.name ?? null,
        chair: a.staff?.name ?? null,
        staffId: a.staffId,
      })),
      blockedTime: chairs.flatMap((c) =>
        (blocks.get(c.id) ?? []).map((b) => ({
          staffId: c.id,
          chair: c.name,
          startsAt: new Date(b.start).toISOString(),
          endsAt: new Date(b.end).toISOString(),
        })),
      ),
    },
  };
}

const openingsSchema = z
  .object({
    from: ymdSchema,
    to: ymdSchema.optional(),
    /** Which service the opening has to fit. Omitted = every active service. */
    serviceId: z.string().min(1).max(40).optional(),
  })
  .strict();

/** Bound on how many (chair, service) pairs one call may plan. */
const MAX_PAIRS = 24;
const MAX_SLOTS = 200;

async function openings(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = openingsSchema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  const clock = await shopClock(inv.shopId);
  if (!clock) {
    return {
      ok: false,
      code: "shop_not_found",
      message: "That shop is no longer available.",
    };
  }

  // Openings are expensive to plan, so the window is tighter than the agenda's.
  const window = windowFor(parsed.data.from, parsed.data.to ?? parsed.data.from, clock, 31);
  if (!window) {
    return {
      ok: false,
      code: "window_too_wide",
      message: "Ask for a range of 31 days or fewer.",
    };
  }

  const { chairs, services } = await runWithShop(inv.shopId, async (tx) => {
    const [chairs, services] = await Promise.all([
      tx.staff.findMany({
        where: {
          shopId: inv.shopId,
          active: true,
          id: inv.chairFilterStaffId ?? undefined,
        },
        select: { id: true, name: true },
      }),
      tx.service.findMany({
        where: {
          shopId: inv.shopId,
          active: true,
          // 🔴 A service id from the request is a FILTER, never a scope: it is
          // matched inside this shop's own rows, so a foreign id selects
          // nothing rather than reaching anything.
          id: parsed.data.serviceId ?? undefined,
        },
        select: { id: true, name: true },
      }),
    ]);
    return { chairs, services };
  });

  if (services.length === 0) {
    return {
      ok: false,
      code: "no_such_service",
      message: "There's no active service by that id at this shop.",
    };
  }

  const pairs: {
    staffId: string;
    chair: string;
    serviceId: string;
    service: string;
  }[] = [];
  for (const c of chairs) {
    for (const s of services) {
      if (pairs.length >= MAX_PAIRS) break;
      pairs.push({
        staffId: c.id,
        chair: c.name,
        serviceId: s.id,
        service: s.name,
      });
    }
  }

  const planned = await Promise.all(
    pairs.map(async (p) => ({
      ...p,
      slots: await computeOpenSlots({
        shopId: inv.shopId,
        staffId: p.staffId,
        serviceId: p.serviceId,
        fromDate: window.from,
        toDate: window.to,
        now: inv.now,
      }),
    })),
  );

  const flat = planned.flatMap((p) =>
    p.slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      staffId: p.staffId,
      chair: p.chair,
      serviceId: p.serviceId,
      service: p.service,
    })),
  );
  flat.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return {
    ok: true,
    resource: { type: "openings", id: null },
    data: {
      timezone: clock.timezone,
      from: parsed.data.from,
      to: parsed.data.to ?? parsed.data.from,
      scope: inv.chairFilterStaffId ? "chair" : "shop",
      truncated: flat.length > MAX_SLOTS || pairs.length >= MAX_PAIRS,
      openings: flat.slice(0, MAX_SLOTS),
    },
  };
}

export const calendarTools: ToolDefinition[] = [
  {
    name: "calendar_agenda",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "First day, YYYY-MM-DD in the shop's timezone.",
        },
        to: {
          type: "string",
          description: "Last day, YYYY-MM-DD. Omit for a single day.",
        },
      },
      required: ["from"],
      additionalProperties: false,
    },
    handler: agenda,
  },
  {
    name: "calendar_openings",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "First day, YYYY-MM-DD in the shop's timezone.",
        },
        to: {
          type: "string",
          description: "Last day, YYYY-MM-DD. Omit for a single day.",
        },
        serviceId: {
          type: "string",
          description: "Only openings that fit this service. Omit for every active service.",
        },
      },
      required: ["from"],
      additionalProperties: false,
    },
    handler: openings,
  },
];
