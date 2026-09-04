import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PLANS } from "@chairback/config";

/**
 * FINANCIAL INVARIANT GUARDS - tests about the SOURCE, so the rule outlives
 * the people who know it.
 *
 *   1. Every Stripe call that moves or reserves money carries a deterministic
 *      idempotency key. A retry without one is a second charge.
 *   2. No deprecated Stripe surface: Charges, Sources, Tokens, Plans, the
 *      legacy Card Element. New Checkout code leaves payment_method_types
 *      unset so Stripe's dynamic methods stay available.
 *   3. Money constants are representable in integer cents.
 *   4. No secret key shape reaches the web or mobile source.
 *   5. A Stripe error is never logged whole from a money module: only its
 *      classification (`stripeErrorFacts`) may reach a log line.
 */

const API_SRC = join(process.cwd(), "src");
const REPO = join(process.cwd(), "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The argument list of a call starting at `openParen`, with balanced parens. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen);
}

/** Stripe methods that create or move money, or reserve it, or bill. */
const MUTATIONS =
  /\.(paymentIntents\.create|refunds\.create|setupIntents\.create|customers\.createBalanceTransaction|customers\.create|subscriptions\.update|checkout\.sessions\.create|terminal\.locations\.create|transfers\.create|payouts\.create|invoiceItems\.create|invoices\.create)\s*\(/g;

const MONEY_MODULES = [
  "billing/payments.ts",
  "billing/cardOnFile.ts",
  "billing/terminal.ts",
  "billing/reconcile.ts",
  "billing/stripe.ts",
  "services/referral.ts",
  "engines/affiliateCredit.ts",
  "billing/connect.ts",
  "routes/webhooks.stripe.ts",
  "routes/webhooks.connect.ts",
];

describe("financial invariants (source guards)", () => {
  const files = walk(API_SRC);

  it("every Stripe mutation carries an idempotency key", () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(MUTATIONS)) {
        const args = callArgs(src, m.index! + m[0].length - 1);
        if (!/idempotencyKey/.test(args)) {
          missing.push(`${relative(API_SRC, file)}: ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("no deprecated Stripe surface is used", () => {
    const hits: string[] = [];
    const DEPRECATED = /\.(charges\.create|tokens\.create|sources\.(create|attach)|plans\.(create|retrieve|list))\s*\(/g;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(DEPRECATED)) hits.push(`${relative(API_SRC, file)}: ${m[1]}`);
    }
    expect(hits).toEqual([]);
  });

  it("Checkout Sessions leave payment_method_types unset (dynamic payment methods stay on)", () => {
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/checkout\.sessions\.create\s*\(/g)) {
        const args = callArgs(src, m.index! + m[0].length - 1);
        if (/payment_method_types/.test(args)) hits.push(relative(API_SRC, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it("plan prices are exact in integer cents", () => {
    for (const plan of Object.values(PLANS)) {
      const cents = plan.priceMonthlyUsd * 100;
      expect(Math.abs(cents - Math.round(cents))).toBeLessThan(1e-6);
      expect(Number.isInteger(Math.round(cents))).toBe(true);
      expect(Math.round(cents)).toBeGreaterThanOrEqual(0);
    }
    expect(Math.round(PLANS.pro.priceMonthlyUsd * 100)).toBe(3499);
    expect(Math.round(PLANS.pro_ai.priceMonthlyUsd * 100)).toBe(7499);
  });

  it("no secret-key shape appears in the web or mobile source", () => {
    const roots = [join(REPO, "apps", "web", "src"), join(REPO, "apps", "mobile")].filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        if (/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET/.test(src)) {
          hits.push(relative(REPO, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("money modules never log a raw Stripe error object", () => {
    // `logger.<level>({ err, ... })` hands pino the whole error, and a Stripe
    // error carries the request, the response headers and - for a card error -
    // the PaymentIntent with its client_secret. Only classified facts may go.
    const hits: string[] = [];
    for (const rel of MONEY_MODULES) {
      const src = readFileSync(join(API_SRC, rel), "utf8");
      for (const m of src.matchAll(/logger\.(error|warn|info)\(\s*\{([^}]*)\}/g)) {
        const fields = m[2]!;
        // The `err` KEY - shorthand (`{ err }`, `{ err, x }`) or explicit
        // (`err: e`). `errName: err instanceof …` is the sanctioned shape.
        if (/(^|[\s,{])err\s*(,|$|:)/.test(fields.trim())) {
          hits.push(`${rel}: logger.${m[1]}({ ${fields.trim().slice(0, 40)}… })`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
