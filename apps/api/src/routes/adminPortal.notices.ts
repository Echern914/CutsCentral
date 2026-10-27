import { Router } from "express";
import { z } from "zod";
import {
  PLATFORM_NOTICE_BODY_MAX,
  PLATFORM_NOTICE_SEVERITIES,
  PLATFORM_NOTICE_TITLE_MAX,
} from "@chairback/config";
import {
  claimNoticePush,
  createNotice,
  deleteNotice,
  findNotice,
  listNoticesForAdmin,
  pushNoticeToOwners,
  resolveNotice,
  toAdminNotice,
  updateNotice,
  type NoticePushOutcome,
  type NoticeRow,
} from "../services/platformNotices.js";

/**
 * Platform notices: the operator's side (services/platformNotices.ts has the
 * rules). Sub-mounted under /api/admin-portal/notices BELOW the two-step gate,
 * so it INHERITS requireUser + requireAdmin (a non-admin gets the portal's
 * existence-hiding 404) and requireAdminStepUp from adminPortal.ts, plus
 * requireAdminIp and the dashboard limiter from the app.ts mount. Every write
 * here reaches every barber's dashboard, which is why it sits behind all of it.
 */
export const noticeAdminRouter: Router = Router();

const iso = z.string().datetime({ offset: true }).transform((s) => new Date(s));

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(PLATFORM_NOTICE_TITLE_MAX),
    body: z.string().trim().min(1).max(PLATFORM_NOTICE_BODY_MAX),
    severity: z.enum(PLATFORM_NOTICE_SEVERITIES),
    startsAt: iso.optional(),
    endsAt: iso.nullable().optional(),
    /** Send ONE push to shop owners' phones. */
    notifyPhones: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(PLATFORM_NOTICE_TITLE_MAX).optional(),
    body: z.string().trim().min(1).max(PLATFORM_NOTICE_BODY_MAX).optional(),
    severity: z.enum(PLATFORM_NOTICE_SEVERITIES).optional(),
    startsAt: iso.optional(),
    endsAt: iso.nullable().optional(),
    /** A notice that has not pushed yet may push once from an edit too. */
    notifyPhones: z.boolean().optional(),
  })
  .strict();

/** The end must come after the start (the table CHECKs it too). */
function windowOk(startsAt: Date, endsAt: Date | null | undefined): boolean {
  return !endsAt || endsAt.getTime() > startsAt.getTime();
}

/** Claim the one push, and start the fan-out after the response when won. */
async function maybePush(row: NoticeRow, requested: boolean | undefined): Promise<NoticePushOutcome | "not_requested"> {
  if (!requested) return "not_requested";
  const outcome = await claimNoticePush(row.id);
  if (outcome === "sending") void pushNoticeToOwners(row);
  return outcome;
}

noticeAdminRouter.get("/", async (_req, res) => {
  const now = new Date();
  const rows = await listNoticesForAdmin();
  res.json({ notices: rows.map((n) => toAdminNotice(n, now)) });
});

noticeAdminRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { notifyPhones, ...input } = parsed.data;
  if (!windowOk(input.startsAt ?? new Date(), input.endsAt)) {
    res.status(400).json({ error: "invalid_window" });
    return;
  }
  const row = await createNotice(input, req.userId!);
  const push = await maybePush(row, notifyPhones);
  const fresh = (await findNotice(row.id)) ?? row;
  res.status(201).json({ notice: toAdminNotice(fresh, new Date()), push });
});

noticeAdminRouter.patch("/:id", async (req, res) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { notifyPhones, ...patch } = parsed.data;
  const before = await findNotice(req.params.id);
  if (!before) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const startsAt = patch.startsAt ?? before.startsAt;
  const endsAt = patch.endsAt === undefined ? before.endsAt : patch.endsAt;
  if (!windowOk(startsAt, endsAt)) {
    res.status(400).json({ error: "invalid_window" });
    return;
  }
  const row = await updateNotice(req.params.id, patch);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const push = await maybePush(row, notifyPhones);
  const fresh = (await findNotice(row.id)) ?? row;
  res.json({ notice: toAdminNotice(fresh, new Date()), push });
});

noticeAdminRouter.post("/:id/resolve", async (req, res) => {
  const row = await resolveNotice(req.params.id);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ notice: toAdminNotice(row, new Date()) });
});

noticeAdminRouter.delete("/:id", async (req, res) => {
  const deleted = await deleteNotice(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
