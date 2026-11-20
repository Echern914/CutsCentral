import type { Request } from "express";
import type { DashboardWriteReq, DashboardWriteRes } from "../routes/booking.dashboard.js";

/**
 * Run one of the dashboard's own write handlers (book, move, cancel) in-process
 * and keep its answer.
 *
 * Why it exists: more than one surface now books on a calendar - the owner's
 * dashboard, the booking chat, and a team member's own calendar. Each of them
 * must run the SAME rules (the overlap guard, the price rules, the refund and
 * fee rules, the client's confirmation), so none of them has its own copy:
 * they call the dashboard's handler through here and read what it answered.
 *
 * 🔴 The caller decides WHAT may be sent. This only carries a body to the
 * handler; it does not narrow it. A surface for a team member builds its body
 * from a strict allow-list (see routes/barberCalendar.ts) - never by
 * forwarding what the browser sent.
 */

/** What the write handlers read from a request, exactly as the middleware sets it. */
export interface WriteActor {
  shop: Request["shop"];
  userId: string;
  shopStaffId: string | null;
}

export interface WriteAnswer {
  status: number;
  body: Record<string, unknown>;
}

export async function runWriteCore(
  core: (req: DashboardWriteReq, res: DashboardWriteRes) => Promise<void>,
  actor: WriteActor,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
): Promise<WriteAnswer> {
  const out: WriteAnswer = { status: 200, body: {} };
  const res: DashboardWriteRes = {
    status(code: number) {
      out.status = code;
      return {
        json(b: unknown) {
          out.body = (b ?? {}) as Record<string, unknown>;
          return undefined;
        },
      };
    },
    json(b: unknown) {
      out.body = (b ?? {}) as Record<string, unknown>;
      return undefined;
    },
  };
  const req: DashboardWriteReq = {
    shop: actor.shop,
    userId: actor.userId,
    shopStaffId: actor.shopStaffId,
    body,
    params,
  };
  await core(req, res);
  return out;
}
