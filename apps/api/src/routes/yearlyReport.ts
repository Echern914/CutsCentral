import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { runWithShop } from "@chairback/db";
import { vocabularyForShop } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireActiveAccess } from "../middleware/billing.js";
import {
  EARLIEST_REPORT_YEAR,
  buildYearlyReport,
  currentShopYear,
  selectableYears,
} from "../engines/yearlyReport.js";
import {
  renderYearlyReportPdf,
  reportFilename,
} from "../reports/yearlyReportPdf.js";

/**
 * The yearly performance report.
 *
 * ── WHY THIS IS NOT ON THE INSIGHTS ROUTER ───────────────────────────────────
 *
 * `/api/insights` is `requireManager`: a BARBER seat gets 403 on all of it,
 * because the shop's whole book is the owner's business. This report is the one
 * thing a barber is entitled to about HIMSELF - his own year, to print for his
 * records, his accountant, or an application to another shop. Widening the
 * insights router to let barbers in would have opened every other card on it
 * too, so the report lives here with a gate of its own that answers a
 * different question: not "what is your rank" but "whose numbers are these".
 *
 * ── THE RULE, ENFORCED IN THREE PLACES ───────────────────────────────────────
 *
 *  1. `resolveReportScope` below. OWNER/MANAGER may ask for the shop or for any
 *     staff row IN THEIR SHOP; a BARBER may ask only for the staff row their
 *     own seat is linked to, and gets 403 for anything else - including the
 *     shop-wide report.
 *  2. The staff id is re-read from the database WITH `shopId` in the WHERE, so
 *     a staff id belonging to another shop resolves to nothing and answers 404.
 *     A caller cannot reach another tenant by editing an id, because the id is
 *     never trusted - it is looked up under this session's shop.
 *  3. Every read runs inside `runWithShop`, so Appointment/Visit/Client are
 *     under FORCE row-level security with `app.current_shop_id` set to THIS
 *     shop. Even a bug in 1 or 2 returns zero rows rather than another shop's.
 *
 * The shop itself is never taken from the request: `requireShop` derives it
 * from the session alone (see middleware/auth.ts), which is why there is no
 * shopId parameter anywhere on this router.
 */
export const yearlyReportRouter: Router = Router();
yearlyReportRouter.use(requireUser, requireShop, requireActiveAccess);

const querySchema = z.object({
  year: z.coerce.number().int().min(EARLIEST_REPORT_YEAR).max(2100).optional(),
  /** A staff id, or "shop" for the whole-shop report. Absent = the caller's default. */
  subject: z.string().min(1).max(64).optional(),
  paper: z.enum(["letter", "a4"]).optional(),
});

interface ReportScope {
  staffId: string | null;
  staffName: string | null;
}

/**
 * Who this request is allowed to report on, or a refusal.
 *
 * Returns a discriminated result rather than writing the response itself, so
 * the two routes below cannot drift into different rules.
 */
async function resolveReportScope(
  req: Request,
  subject: string | undefined,
): Promise<
  | { ok: true; scope: ReportScope }
  | { ok: false; status: 403 | 404; error: string }
> {
  const shop = req.shop!;
  const role = req.shopRole ?? "BARBER";
  const isManager = role === "OWNER" || role === "MANAGER";
  const ownStaffId = req.shopStaffId ?? null;

  // What "no subject" means depends on who is asking: an owner means the shop,
  // a barber means himself. A barber whose seat is not linked to a chair has
  // no numbers of his own to report and is told so, rather than being handed
  // the shop's.
  const wanted = subject ?? (isManager ? "shop" : (ownStaffId ?? ""));

  if (wanted === "shop") {
    if (!isManager) return { ok: false, status: 403, error: "forbidden_subject" };
    return { ok: true, scope: { staffId: null, staffName: null } };
  }
  if (!wanted) return { ok: false, status: 403, error: "no_linked_staff" };
  if (!isManager && wanted !== ownStaffId) {
    // Same 403 whether the id exists or not: a barber must not be able to
    // enumerate his colleagues' staff ids by watching the status code change.
    return { ok: false, status: 403, error: "forbidden_subject" };
  }

  // Re-read under the session's shop. This is the check that makes a
  // hand-edited id from another shop a 404 rather than a leak.
  const staff = await runWithShop(shop.id, (tx) =>
    tx.staff.findFirst({
      where: { id: wanted, shopId: shop.id },
      select: { id: true, name: true },
    }),
  );
  if (!staff) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, scope: { staffId: staff.id, staffName: staff.name } };
}

/** A report is private to one shop and must never sit in a shared cache. */
function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  // The PDF is served from the API origin and is not a page; nothing should
  // ever frame it or sniff it into something else.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Which years and which subjects this caller may ask for. Drives the picker, so
 * the UI can never offer an option the API would refuse.
 */
yearlyReportRouter.get("/options", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const role = req.shopRole ?? "BARBER";
  const isManager = role === "OWNER" || role === "MANAGER";
  const ownStaffId = req.shopStaffId ?? null;

  const staff = await runWithShop(shop.id, (tx) =>
    tx.staff.findMany({
      where: {
        shopId: shop.id,
        // A barber sees exactly one name in the picker - his own. The list is
        // filtered in the QUERY, not in the response mapping, so a colleague's
        // name never travels to a browser that may not show it.
        ...(isManager ? {} : { id: ownStaffId ?? "__none__" }),
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, active: true },
    }),
  );

  noStore(res);
  res.json({
    years: selectableYears(now, shop.timezone, shop.createdAt),
    currentYear: currentShopYear(now, shop.timezone),
    timezone: shop.timezone,
    canReportShop: isManager,
    defaultSubject: isManager ? "shop" : ownStaffId,
    shopName: shop.name,
    subjects: staff.map((s) => ({ id: s.id, name: s.name, active: s.active })),
  });
});

/** The report as data - what the on-screen preview renders. */
yearlyReportRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  const year = parsed.data.year ?? currentShopYear(now, shop.timezone);
  if (year > currentShopYear(now, shop.timezone)) {
    // A year that has not started has no data and no honest label.
    res.status(400).json({ error: "invalid_year" });
    return;
  }
  const scope = await resolveReportScope(req, parsed.data.subject);
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error });
    return;
  }

  const report = await buildYearlyReport({
    shopId: shop.id,
    shopName: shop.name,
    timezone: shop.timezone,
    providerNoun: vocabularyForShop(shop).providerNoun,
    year,
    staffId: scope.scope.staffId,
    staffName: scope.scope.staffName,
    now,
  });
  noStore(res);
  res.json({ report, filename: reportFilename(report) });
});

/**
 * The report as a real PDF.
 *
 * Same engine, same instant-bounded window, same numbers as the JSON above and
 * as the Insights page - see engines/yearlyReport.ts. The only thing this route
 * adds is the ink.
 */
yearlyReportRouter.get("/pdf", async (req, res) => {
  const shop = req.shop!;
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  const year = parsed.data.year ?? currentShopYear(now, shop.timezone);
  if (year > currentShopYear(now, shop.timezone)) {
    res.status(400).json({ error: "invalid_year" });
    return;
  }
  const scope = await resolveReportScope(req, parsed.data.subject);
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error });
    return;
  }

  const report = await buildYearlyReport({
    shopId: shop.id,
    shopName: shop.name,
    timezone: shop.timezone,
    providerNoun: vocabularyForShop(shop).providerNoun,
    year,
    staffId: scope.scope.staffId,
    staffName: scope.scope.staffName,
    now,
  });
  const pdf = renderYearlyReportPdf(report, { paper: parsed.data.paper ?? "letter", now });

  noStore(res);
  res.setHeader("Content-Type", "application/pdf");
  // `inline` so a phone can preview it in place and hand it to the share sheet;
  // the filename is still what a Save produces.
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${reportFilename(report)}"`,
  );
  res.setHeader("Content-Length", String(pdf.length));
  res.end(pdf);
});
