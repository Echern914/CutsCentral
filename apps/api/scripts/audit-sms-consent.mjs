/**
 * Audit SMS consent provenance — READ ONLY, changes nothing.
 *
 * Before you flip DRY_RUN=false and start sending real texts, you want to be
 * sure every client you'd text actually opted in — and that you can SAY HOW.
 * Under TCPA the burden is on you to prove consent, so a smsConsentAt timestamp
 * with no recorded source is a liability, not an asset.
 *
 * This groups every client that is currently TEXTABLE (smsConsentAt set AND
 * optedOut = false AND has a phone) by smsConsentSource, so you can see at a
 * glance whether your consent records have clear provenance or whether some
 * were set without a documented basis (e.g. an old sync default).
 *
 *   acuity_intake  — client checked the SMS consent box on the Acuity form  ✅ defensible
 *   barber_attest  — barber attested they have permission                   ✅ defensible
 *   join_page      — client opted in on the public rewards/join page        ✅ defensible
 *   manual         — entered by hand                                        ⚠️  weaker, know why
 *   (null/empty)   — consent set but NO source recorded                     ❌ investigate before sending
 *
 * It prints per-source counts across all shops, then flags the sourceless
 * textable clients (the ones that are genuine risk) with a small sample.
 *
 * Run:  node apps/api/scripts/audit-sms-consent.mjs
 *       node apps/api/scripts/audit-sms-consent.mjs --shop <shopId>   (scope to one shop)
 */
import { config } from "dotenv";
config();

import { PrismaClient } from "../../../packages/db/src/generated/client/index.js";

const prisma = new PrismaClient();

const shopArgIdx = process.argv.indexOf("--shop");
const shopFilter = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

// A source we'd be comfortable defending if a carrier or regulator asked.
const DEFENSIBLE = new Set(["acuity_intake", "barber_attest", "join_page"]);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  console.log(`\nAuditing consent on: ${hostOf(process.env.DATABASE_URL ?? "")}`);
  if (shopFilter) console.log(`Scoped to shop: ${shopFilter}`);

  // "Textable" = the exact gate the eligibility engine + manual send enforce:
  // consent timestamp present, not opted out, has a phone number.
  const baseWhere = {
    smsConsentAt: { not: null },
    optedOut: false,
    phone: { not: null },
    archivedAt: null,
    ...(shopFilter ? { shopId: shopFilter } : {}),
  };

  const textable = await prisma.client.count({ where: baseWhere });
  console.log(`\nTextable clients (consented, not opted out, has phone): ${textable}`);

  if (textable === 0) {
    console.log("\nNothing to audit. ✅");
    return;
  }

  // Group by source.
  const grouped = await prisma.client.groupBy({
    by: ["smsConsentSource"],
    where: baseWhere,
    _count: { _all: true },
  });

  console.log("\nBy consent source:");
  let risky = 0;
  for (const g of grouped.sort((a, b) => b._count._all - a._count._all)) {
    const src = g.smsConsentSource ?? "(none recorded)";
    const n = g._count._all;
    const defensible = g.smsConsentSource && DEFENSIBLE.has(g.smsConsentSource);
    const mark = defensible ? "✅" : g.smsConsentSource === "manual" ? "⚠️ " : "❌";
    if (!defensible && g.smsConsentSource !== "manual") risky += n;
    console.log(`  ${mark} ${src.padEnd(18)} ${n}`);
  }

  // Show a sample of the genuinely risky ones (no source at all).
  if (risky > 0) {
    console.log(
      `\n❌ ${risky} textable client(s) have consent set with NO recorded source.`,
    );
    console.log("   These are the ones to investigate before sending. Sample:");
    const sample = await prisma.client.findMany({
      where: { ...baseWhere, smsConsentSource: null },
      select: {
        id: true,
        shopId: true,
        firstName: true,
        lastName: true,
        smsConsentAt: true,
        source: true,
      },
      take: 10,
      orderBy: { smsConsentAt: "asc" },
    });
    for (const c of sample) {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)";
      console.log(
        `     - ${name} · shop ${c.shopId.slice(0, 8)} · consent ${c.smsConsentAt?.toISOString().slice(0, 10)} · synced-from ${c.source}`,
      );
    }
    console.log(
      "\n   If these came from an old sync default rather than a real opt-in, clear\n" +
        "   smsConsentAt for them (a targeted UPDATE) before DRY_RUN=false.",
    );
  } else {
    console.log("\n✅ Every textable client has a defensible consent source.");
  }
  console.log("");
}

main()
  .catch((e) => {
    console.error("audit-sms-consent failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
