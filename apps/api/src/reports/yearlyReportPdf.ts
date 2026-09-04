import {
  BOLD,
  PdfPage,
  REGULAR,
  SAFE_BOX,
  buildPdf,
  fitText,
  rgb,
  textWidth,
  type PaperSize,
} from "./pdf.js";
import type { YearlyReport } from "../engines/yearlyReport.js";

/**
 * The printed yearly report: one page, ChairBack's own document.
 *
 * The layout is FIXED, not flowed. Every band below has a declared top and
 * height, the sections that can vary in length (services, notes) are clipped to
 * a fixed number of rows, and every string that could be long is measured and
 * truncated by `fitText`. That is what makes "fits on one page" a property of
 * the code rather than a thing to check by eye - there is no arrangement of the
 * data that can produce a second page, because nothing here can grow.
 *
 * Colours come from ChairBack's LIGHT theme (globals.css), which is the palette
 * designed to be read on white: warm near-black #1C1917 on paper, a muted
 * #57534E that still clears 6:1, and the deeper gold #9A7A1F rather than the
 * dark-mode #D4AF37, which is too light to print. Nothing relies on a
 * background tint being visible - every tint here is decoration behind text
 * that is already legible without it.
 */

const INK = rgb("#1C1917");
const MUTED = rgb("#57534E");
const GOLD = rgb("#9A7A1F");
const GOLD_TINT = rgb("#F5EFDF");
const CARD = rgb("#F7F6F3");
const RULE = rgb("#D6D3CD");
const BAR = rgb("#9A7A1F");
const BAR_FAINT = rgb("#DCCEA8");
const WHITE = rgb("#FFFFFF");

const M = 40; // page margin
const W = SAFE_BOX.width - M * 2; // 515.28pt of usable width
const RIGHT = M + W;

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Cents as "$12,345.67" - exact, because an accountant may read this. */
export function money(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars.toLocaleString("en-US")}.${rest}`;
}

/** Cents as "$12,345" - for the big tiles, where the cents are noise. */
function moneyWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** Basis points as "62.5%", or the honest dash when there was no denominator. */
export function percent(bp: number | null): string {
  if (bp === null) return "—";
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** "Jan 1, 2026" from a shop-local YYYY-MM-DD, kept out of the local timezone. */
export function prettyDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

/** The download name. ASCII, lowercase, hyphenated - safe on every filesystem. */
export function reportFilename(report: YearlyReport): string {
  const slug = report.subjectName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `chairback-${slug || "report"}-${report.year}-report.pdf`;
}

export function renderYearlyReportPdf(
  report: YearlyReport,
  opts: { paper?: PaperSize; now?: Date } = {},
): Buffer {
  const page = new PdfPage();
  const now = opts.now ?? new Date(report.generatedAt);

  header(page, report);
  identity(page, report);
  const summaryBottom = summaryTiles(page, report);
  const metricsBottom = metricGrid(page, report, summaryBottom + 18);
  const chartBottom = monthlyChart(page, report, metricsBottom + 20);
  bottomSections(page, report, chartBottom + 20);
  footer(page, report);

  return buildPdf({
    page,
    paper: opts.paper ?? "letter",
    // 🔴 Deliberately generic and name-free: /Info travels with the file and
    // is read by tools nobody thinks about. The document says who it is about
    // on its face; the metadata does not need to.
    title: `ChairBack Yearly Performance Report ${report.year}`,
    now,
  });
}

function header(page: PdfPage, report: YearlyReport): void {
  page.text("CHAIRBACK", M, 52, { size: 14, font: BOLD, color: GOLD });
  page.text("YEARLY PERFORMANCE REPORT", RIGHT, 52, {
    size: 8.5,
    font: BOLD,
    color: MUTED,
    align: "right",
  });
  page.rect(M, 60, W, 1.6, GOLD);
}

function identity(page: PdfPage, report: YearlyReport): void {
  // The right column is sized first, and the name gets whatever is left. A
  // 60-character shop name therefore shortens itself instead of running under
  // the dates - the failure mode that makes a printed page look broken.
  const range = `${prettyDay(report.rangeStart)} – ${prettyDay(report.rangeEnd)}`;
  const rangeW = Math.max(
    textWidth(report.periodLabel, 15, BOLD),
    textWidth(range, 8.5, REGULAR),
  );
  const nameMax = W - rangeW - 24;

  page.text(fitText(report.subjectName, nameMax, 22, BOLD), M, 92, {
    size: 22,
    font: BOLD,
    color: INK,
  });
  const sub =
    report.scope === "staff"
      ? `Barber at ${report.shopName}`
      : "Whole-shop performance summary";
  page.text(fitText(sub, nameMax, 10, REGULAR), M, 108, {
    size: 10,
    color: MUTED,
  });

  page.text(report.periodLabel, RIGHT, 90, {
    size: 15,
    font: BOLD,
    color: GOLD,
    align: "right",
  });
  page.text(range, RIGHT, 104, { size: 8.5, color: MUTED, align: "right" });
  page.text(
    `Report generated ${prettyDay(report.generatedAt.slice(0, 10))} · ${report.timezone}`,
    RIGHT,
    116,
    { size: 8.5, color: MUTED, align: "right" },
  );

  page.line(M, 128, RIGHT, 128, RULE, 0.6);
}

/** The four numbers a barber is actually asked for, in a gold band. */
function summaryTiles(page: PdfPage, report: YearlyReport): number {
  const top = 140;
  const h = 74;
  page.rect(M, top, W, h, GOLD_TINT);
  page.rect(M, top, 3, h, GOLD);

  const t = report.totals;
  const tiles: [string, string][] = [
    ["Appointments completed", t.appointments.toLocaleString("en-US")],
    ["Total revenue", moneyWhole(t.revenueCents)],
    ["Clients served", t.uniqueClients.toLocaleString("en-US")],
    ["Average ticket", t.avgTicketCents === null ? "—" : money(t.avgTicketCents)],
  ];
  const colW = (W - 14) / tiles.length;
  tiles.forEach(([label, value], i) => {
    const cx = M + 14 + colW * i;
    page.text(label.toUpperCase(), cx, top + 22, { size: 7.5, font: BOLD, color: MUTED });
    page.text(fitText(value, colW - 14, 21, BOLD), cx, top + 50, {
      size: 21,
      font: BOLD,
      color: INK,
    });
    if (i > 0) page.line(cx - 12, top + 12, cx - 12, top + h - 12, RULE, 0.6);
  });
  // Revenue is the one figure that must never be read as more than it is.
  page.text(
    `All amounts in ${report.currency}. Revenue is money earned: collected payments net of refunds, plus work settled at the chair.`,
    M + 14,
    top + 66,
    { size: 7, color: MUTED },
  );
  return top + h;
}

/** Eight supporting metrics as clean cards, four across, two down. */
function metricGrid(page: PdfPage, report: YearlyReport, top: number): number {
  const t = report.totals;
  const cells: [string, string, string?][] = [
    ["New clients", t.newClients.toLocaleString("en-US"), "first ever visit this year"],
    ["Returning clients", t.returningClients.toLocaleString("en-US"), "came back to you"],
    ["Client return rate", percent(t.returnRateBp), "of clients served"],
    ["Avg monthly revenue", moneyWhole(t.avgMonthlyRevenueCents), "over the range"],
    ["No-shows", t.noShows.toLocaleString("en-US"), `${percent(t.noShowRateBp)} of bookings`],
    [
      "Cancellations",
      t.cancellations.toLocaleString("en-US"),
      `${percent(t.cancellationRateBp)} of bookings`,
    ],
    ["Busiest month", report.busiest.month ?? "—", "by appointments"],
    ["Busiest day", report.busiest.weekday ?? "—", "of the week"],
  ];

  const gap = 9;
  const colW = (W - gap * 3) / 4;
  const rowH = 50;
  cells.forEach(([label, value, note], i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = M + col * (colW + gap);
    const y = top + row * (rowH + gap);
    page.rect(x, y, colW, rowH, CARD);
    page.text(fitText(label, colW - 16, 7.5, BOLD).toUpperCase(), x + 8, y + 15, {
      size: 7.5,
      font: BOLD,
      color: MUTED,
    });
    page.text(fitText(value, colW - 16, 16, BOLD), x + 8, y + 33, {
      size: 16,
      font: BOLD,
      color: INK,
    });
    if (note) {
      page.text(fitText(note, colW - 16, 6.8, REGULAR), x + 8, y + 43, {
        size: 6.8,
        color: MUTED,
      });
    }
  });
  return top + rowH * 2 + gap;
}

/**
 * Revenue by month, twelve bars.
 *
 * A month the window does not fully cover (the current one, on a year-to-date
 * report) is drawn in a faint tone and marked, so a half-finished September is
 * never read as a collapse in business.
 */
function monthlyChart(page: PdfPage, report: YearlyReport, top: number): number {
  const h = 128;
  const plotTop = top + 24;
  const plotH = h - 44;
  const baseline = plotTop + plotH;

  page.text("REVENUE BY MONTH", M, top + 10, { size: 8, font: BOLD, color: MUTED });
  const peak = Math.max(...report.months.map((m) => m.revenueCents), 0);
  page.text(
    peak > 0 ? `Peak ${moneyWhole(peak)}` : "No revenue recorded in this range",
    RIGHT,
    top + 10,
    { size: 8, color: MUTED, align: "right" },
  );

  page.line(M, baseline, RIGHT, baseline, RULE, 0.6);

  const slot = W / 12;
  const barW = Math.min(26, slot - 10);
  report.months.forEach((m, i) => {
    const cx = M + slot * i + slot / 2;
    // A month with money always draws at least a sliver: a 1px bar says "a
    // little", an absent bar says "nothing", and those are different facts.
    const barH = peak > 0 && m.revenueCents > 0 ? Math.max(2, (m.revenueCents / peak) * plotH) : 0;
    if (barH > 0) {
      page.rect(cx - barW / 2, baseline - barH, barW, barH, m.complete ? BAR : BAR_FAINT);
    }
    page.text(MONTHS_SHORT[i]!, cx, baseline + 11, {
      size: 7,
      color: MUTED,
      align: "center",
    });
    if (m.appointments > 0) {
      page.text(String(m.appointments), cx, baseline + 20, {
        size: 6.5,
        font: BOLD,
        color: MUTED,
        align: "center",
      });
    }
  });
  page.text("Bar = revenue · number below = appointments", M, baseline + 31, {
    size: 6.8,
    color: MUTED,
  });
  if (report.months.some((m) => !m.complete && m.revenueCents > 0)) {
    page.text("Lighter bar = month still in progress", RIGHT, baseline + 31, {
      size: 6.8,
      color: MUTED,
      align: "right",
    });
  }
  return top + h;
}

/** Top services on the left; what the numbers do and don't cover on the right. */
function bottomSections(page: PdfPage, report: YearlyReport, top: number): void {
  const colW = (W - 18) / 2;
  const rightX = M + colW + 18;

  page.text("MOST BOOKED SERVICES", M, top + 8, { size: 8, font: BOLD, color: MUTED });
  page.line(M, top + 13, M + colW, top + 13, RULE, 0.6);

  const rows = report.services.slice(0, 5);
  if (rows.length === 0) {
    page.text("No bookings in this range.", M, top + 28, { size: 8.5, color: MUTED });
  } else {
    rows.forEach((s, i) => {
      const y = top + 28 + i * 15;
      page.text(fitText(s.name, colW - 150, 8.5, REGULAR), M, y, { size: 8.5, color: INK });
      page.text(`${s.count}`, M + colW - 96, y, {
        size: 8.5,
        font: BOLD,
        color: INK,
        align: "right",
      });
      page.text(moneyWhole(s.revenueCents), M + colW, y, {
        size: 8.5,
        color: MUTED,
        align: "right",
      });
    });
  }

  page.text("HOW THESE NUMBERS ARE MEASURED", rightX, top + 8, {
    size: 8,
    font: BOLD,
    color: MUTED,
  });
  page.line(rightX, top + 13, rightX + colW, top + 13, RULE, 0.6);

  const notes: string[] = [
    `An appointment counts in the month it was SCHEDULED for, in ${report.timezone}.`,
    "Canceled bookings are never counted as work or as revenue.",
    "A no-show earns nothing unless a fee was actually collected.",
    "Refunded and unsettled payments are not counted as revenue.",
  ];
  if (report.scope === "staff" && report.syncedExcluded) {
    notes.push("Bookings synced from another calendar carry no barber, so they are not here.");
  }
  for (const u of report.unavailable) notes.push(`${u.label}: ${u.reason}`);

  // Hard-capped at six lines of two: the section cannot grow past its band,
  // whatever a future release adds to `unavailable`.
  let y = top + 27;
  for (const note of notes.slice(0, 6)) {
    const lines = wrap(note, colW - 10, 7.2);
    for (const line of lines.slice(0, 2)) {
      page.text(line, rightX + 6, y, { size: 7.2, color: MUTED });
      y += 9;
    }
    y += 1.5;
  }
  page.rect(rightX, top + 20, 1.5, y - top - 24, RULE);
}

/** Greedy word wrap against real Helvetica widths. */
function wrap(text: string, maxWidth: number, size: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, REGULAR) > maxWidth && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

function footer(page: PdfPage, report: YearlyReport): void {
  const y = SAFE_BOX.height - 52;
  page.line(M, y, RIGHT, y, RULE, 0.6);
  page.text("Generated by ChairBack", M, y + 14, { size: 8.5, font: BOLD, color: GOLD });
  page.text(
    "Operational performance summary. Not a tax return or audited financial statement.",
    M,
    y + 25,
    { size: 7.2, color: MUTED },
  );
  page.text(`getchairback.com · ${report.periodLabel}`, RIGHT, y + 14, {
    size: 7.5,
    color: MUTED,
    align: "right",
  });
  // A white cap under the footer proves nothing can be drawn below it. It also
  // keeps the page's last mark inside the safe box on both paper sizes.
  page.rect(M, SAFE_BOX.height - 22, W, 6, WHITE);
}
