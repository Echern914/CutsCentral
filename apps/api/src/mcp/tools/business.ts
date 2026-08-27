import { z } from "zod";
import { runWithShop } from "@chairback/db";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";
import { shopClock, windowFor, ymdSchema } from "./shopTime.js";

/**
 * How the business did over a window.
 *
 * Carries NO customer data at all — it is counts and totals, which is what
 * "how was last month" actually means. That also makes it the one shop-data
 * tool with nothing to minimise.
 *
 * 🔴 REVENUE IS TWO SOURCES, NOT ONE. Money reaches a shop as a Stripe payment
 * OR as cash/Zelle/card taken at the chair (`Appointment.paidAmount`), and the
 * schema comment is explicit that the two never overlap. Counting only one is
 * how a summary tells a barber they earned half what they did — so both are
 * summed here, and reported separately as well as together so the number can be
 * checked rather than trusted.
 */

const MAX_DAYS = 366;

const schema = z
  .object({
    from: ymdSchema,
    to: ymdSchema,
  })
  .strict();

/** Statuses that represent work actually done. */
const EARNED = ["COMPLETED", "BOOKED"] as const;

async function summary(inv: ToolInvocation): Promise<ToolResult> {
  const parsed = schema.safeParse(inv.args ?? {});
  if (!parsed.success) return INVALID_ARGS;

  const clock = await shopClock(inv.shopId);
  if (!clock) {
    return {
      ok: false,
      code: "shop_not_found",
      message: "That shop is no longer available.",
    };
  }
  const window = windowFor(parsed.data.from, parsed.data.to, clock, MAX_DAYS);
  if (!window) {
    return {
      ok: false,
      code: "window_too_wide",
      message: "Ask for a range of a year or less.",
    };
  }

  // ONE shop-scoped transaction. groupBy is only reachable through the real
  // tx client - forShop() is a hand-written facade that deliberately exposes
  // find/count/write and nothing else.
  const { byStatus, chairRows, serviceRows, chairs, services } = await runWithShop(
    inv.shopId,
    async (tx) => {
      const where = {
        shopId: inv.shopId,
        startsAt: { gte: window.from, lt: window.to },
      };
      const earned = { ...where, status: { in: [...EARNED] } };

      const [byStatus, chairRows, serviceRows, chairs] = await Promise.all([
        tx.appointment.groupBy({
          by: ["status"],
          where,
          _count: { _all: true },
        }),
        tx.appointment.groupBy({
          by: ["staffId"],
          where: earned,
          _count: { _all: true },
          _sum: { paidAmount: true, priceAtBooking: true },
        }),
        tx.appointment.groupBy({
          by: ["serviceId"],
          where: earned,
          _count: { _all: true },
        }),
        tx.staff.findMany({
          where: { shopId: inv.shopId },
          select: { id: true, name: true },
        }),
      ]);

      const services = await tx.service.findMany({
        where: {
          shopId: inv.shopId,
          id: { in: serviceRows.map((r) => r.serviceId) },
        },
        select: { id: true, name: true },
      });

      return { byStatus, chairRows, serviceRows, chairs, services };
    },
  );

  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const chairName = new Map(chairs.map((c) => [c.id, c.name]));

  const count = (status: string) => byStatus.find((r) => r.status === status)?._count._all ?? 0;

  const collectedAtChair = chairRows.reduce((sum, r) => sum + Number(r._sum.paidAmount ?? 0), 0);
  const bookedValue = chairRows.reduce((sum, r) => sum + Number(r._sum.priceAtBooking ?? 0), 0);

  return {
    ok: true,
    resource: { type: "business_summary", id: null },
    data: {
      timezone: clock.timezone,
      from: parsed.data.from,
      to: parsed.data.to,
      appointments: {
        booked: count("BOOKED"),
        completed: count("COMPLETED"),
        canceled: count("CANCELED"),
        noShow: count("NO_SHOW"),
        pending: count("PENDING"),
      },
      revenue: {
        // Named rather than merged into one ambiguous "revenue", because they
        // answer different questions: one is money in hand, the other is what
        // the calendar was worth at the price it was booked at.
        collectedAtChair,
        bookedValue,
        currency: "USD",
      },
      byChair: chairRows.map((r) => ({
        staffId: r.staffId,
        chair: chairName.get(r.staffId) ?? null,
        appointments: r._count._all,
        collectedAtChair: Number(r._sum.paidAmount ?? 0),
        bookedValue: Number(r._sum.priceAtBooking ?? 0),
      })),
      byService: serviceRows
        .map((r) => ({
          serviceId: r.serviceId,
          service: serviceName.get(r.serviceId) ?? null,
          appointments: r._count._all,
        }))
        .sort((a, b) => b.appointments - a.appointments)
        .slice(0, 25),
    },
  };
}

export const businessTools: ToolDefinition[] = [
  {
    name: "business_summary",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "First day, YYYY-MM-DD in the shop's timezone.",
        },
        to: { type: "string", description: "Last day, YYYY-MM-DD." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: summary,
  },
];
