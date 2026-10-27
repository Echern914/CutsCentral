import { Router } from "express";
import { z } from "zod";
import { runWithShop } from "@chairback/db";
import {
  EXPENSE_CADENCES,
  EXPENSE_CATEGORIES,
  EXPENSE_LABEL_MAX,
  EXPENSE_MAX_CENTS,
  isDateKey,
} from "@chairback/config/expenseSchedule";
import {
  EXPENSE_SELECT,
  dateFromKey,
  dateKeyOf,
  listShopExpenses,
  toExpenseRow,
} from "../engines/shopExpenses.js";
import { shopLocalDay } from "../engines/insightsWindow.js";

/**
 * SHOP EXPENSES - /api/insights/expenses
 *
 * The barber's own business costs (rent they pay, products, supplies, other),
 * feeding the take-home ESTIMATE on Insights. Mounted under insightsRouter, so
 * every route here already sits behind requireUser + requireShop +
 * requireManager (OWNER/MANAGER only) + requireActiveAccess.
 *
 *   GET    /           the live list
 *   POST   /           add one
 *   PUT    /:id        replace one's fields (the form always sends them all)
 *   DELETE /:id        archive (soft delete) - it stops counting everywhere
 *
 * 🔴 SHOP-SCOPED TWICE: every read and write runs in runWithShop (FORCE RLS on
 * ShopExpense) AND names shopId in its where. An id from another shop is a
 * 404, never a write - the same answer as an id that does not exist, so the
 * route cannot be used to learn that another shop's row exists.
 */
export const insightsExpensesRouter: Router = Router();

const dateKey = z
  .string()
  .refine(isDateKey, "date_invalid")
  // A sane calendar: catches a year typed as 0026 or 20266.
  .refine((k) => {
    const y = Number(k.slice(0, 4));
    return y >= 2000 && y <= 2100;
  }, "date_out_of_range");

const expenseBody = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES),
    label: z
      .string()
      .trim()
      .max(EXPENSE_LABEL_MAX)
      .nullish()
      .transform((v) => (v ? v : null)),
    amountCents: z.number().int().min(1).max(EXPENSE_MAX_CENTS),
    cadence: z.enum(EXPENSE_CADENCES),
    startDate: dateKey,
    endDate: dateKey.nullish().transform((v) => v ?? null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.cadence === "once" && v.endDate !== null) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "once_has_no_end" });
    }
    // Keys compare lexically = chronologically.
    if (v.endDate !== null && v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "end_before_start" });
    }
  });

type ExpenseBody = z.infer<typeof expenseBody>;

function dataOf(b: ExpenseBody) {
  return {
    category: b.category,
    label: b.label,
    amountCents: b.amountCents,
    cadence: b.cadence,
    startDate: dateFromKey(b.startDate),
    endDate: b.endDate ? dateFromKey(b.endDate) : null,
  };
}

/** The first problem as a stable code the web turns into a sentence. */
function problemOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid_input";
  if (issue.code === "custom" && issue.message) return issue.message;
  const field = issue.path[0];
  return typeof field === "string" ? `${field}_invalid` : "invalid_input";
}

insightsExpensesRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const expenses = await runWithShop(shop.id, (tx) => listShopExpenses(tx, shop.id));
  // The shop's own today, so the form's default date is the shop's calendar
  // day and not the phone's.
  res.json({ expenses, today: dateKeyOf(shopLocalDay(new Date(), shop.timezone)) });
});

insightsExpensesRouter.post("/", async (req, res) => {
  const shop = req.shop!;
  const parsed = expenseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: problemOf(parsed.error) });
    return;
  }
  const created = await runWithShop(shop.id, (tx) =>
    tx.shopExpense.create({
      data: { shopId: shop.id, createdByUserId: req.userId ?? null, ...dataOf(parsed.data) },
      select: EXPENSE_SELECT,
    }),
  );
  res.status(201).json({ expense: toExpenseRow(created) });
});

const idParam = z.string().min(1).max(64);

insightsExpensesRouter.put("/:id", async (req, res) => {
  const shop = req.shop!;
  const id = idParam.safeParse(req.params.id);
  const parsed = expenseBody.safeParse(req.body ?? {});
  if (!id.success || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "invalid_input" : problemOf(parsed.error) });
    return;
  }
  const updated = await runWithShop(shop.id, async (tx) => {
    // updateMany so the shop filter is part of the WRITE, not a read before it.
    const r = await tx.shopExpense.updateMany({
      where: { id: id.data, shopId: shop.id, archivedAt: null },
      data: dataOf(parsed.data),
    });
    if (r.count === 0) return null;
    return tx.shopExpense.findFirst({ where: { id: id.data, shopId: shop.id }, select: EXPENSE_SELECT });
  });
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ expense: toExpenseRow(updated) });
});

insightsExpensesRouter.delete("/:id", async (req, res) => {
  const shop = req.shop!;
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const r = await runWithShop(shop.id, (tx) =>
    tx.shopExpense.updateMany({
      where: { id: id.data, shopId: shop.id, archivedAt: null },
      data: { archivedAt: new Date() },
    }),
  );
  if (r.count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
