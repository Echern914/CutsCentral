"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { cap, useVocab } from "@/components/VocabProvider";
import {
  yearlyReportAction,
  yearlyReportOptionsAction,
  type YearlyReportData,
  type YearlyReportOptions,
} from "./actions";

/**
 * The yearly performance report, from the Insights page.
 *
 * A barber prints this for his own records, sends it to an accountant, attaches
 * it to an application at another shop, or puts it in front of a lender. So the
 * screen has one job beyond looking right: never to show a number the printed
 * page will not show. Both come from ONE payload
 * (`GET /api/yearly-report`), and the PDF is rendered by the API from that same
 * payload - there is no arithmetic in this file at all. Formatting only.
 *
 * 🔴 NO TOTALS ARE COMPUTED HERE. Not one sum, not one average, not one rate.
 * Every figure below is read straight off the response. The moment a frontend
 * starts adding money up, it becomes a second implementation of the definition
 * of revenue, and the day it drifts is the day a barber's printed evidence
 * disagrees with the screen he checked it against.
 */

/** Cents as "$12,345.67" - the same formatter the PDF uses, same output. */
function money(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(
    abs % 100,
  ).padStart(2, "0")}`;
}

/** Cents as "$12,345" - for the headline tiles, where the cents are noise. */
function moneyWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** Basis points as "62.5%", or an honest dash when there was no denominator. */
function percent(bp: number | null): string {
  if (bp === null) return "—";
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jan 1, 2026" from a shop-local YYYY-MM-DD, kept out of the viewer's zone. */
function prettyDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

export function YearlyReport() {
  // A barbershop says "barber", a salon says "stylist", a nail bar says "nail
  // tech". Hard-coding any of them is the exact failure the vocabulary guard
  // exists to catch (packages/config/vocabularyLint.test.ts), and this copy is
  // the customer-facing kind it is strictest about.
  const vocab = useVocab();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<YearlyReportOptions | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [report, setReport] = useState<YearlyReportData | null>(null);
  const [filename, setFilename] = useState<string>("chairback-report.pdf");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "download" | "share">(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // Options are read once, when the sheet is first opened - not on page load.
  // Insights is a heavy page already and most visits never ask for a report.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    void yearlyReportOptionsAction().then((o) => {
      if (cancelled || !o) return;
      setOptions(o);
      setYear((y) => y ?? o.years[0] ?? o.currentYear);
      setSubject((s) => s ?? o.defaultSubject ?? (o.canReportShop ? "shop" : null));
    });
    return () => {
      cancelled = true;
    };
  }, [open, options]);

  const load = useCallback(async () => {
    if (year === null || subject === null) return;
    setLoading(true);
    setError(null);
    const res = await yearlyReportAction({ year, subject });
    setLoading(false);
    if (!res) {
      setError("Couldn't build that report. Try again in a moment.");
      return;
    }
    if ("error" in res) {
      setError(
        res.error === "forbidden"
          ? "You can only generate your own report."
          : `That ${vocab.providerNoun} isn't in this shop.`,
      );
      setReport(null);
      return;
    }
    setReport(res.report);
    setFilename(res.filename);
  }, [year, subject]);

  // Reload whenever the selection changes, so Preview is never stale relative
  // to the pickers above it.
  useEffect(() => {
    if (!open || year === null || subject === null) return;
    void load();
  }, [open, year, subject, load]);

  const pdfUrl = (extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({
      year: String(year ?? ""),
      subject: subject ?? "",
      ...extra,
    });
    return `/dashboard/insights/report/pdf?${qs.toString()}`;
  };

  /**
   * Save the PDF.
   *
   * Fetched rather than linked so a failure is a MESSAGE rather than a tab that
   * opens onto a JSON error - the API can legitimately refuse (not your
   * report), and a browser handles that far worse than we can.
   */
  async function download() {
    setBusy("download");
    setError(null);
    try {
      const res = await fetch(pdfUrl({ download: "1" }), { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick: revoking synchronously can cancel the
      // download on some browsers before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError("Couldn't download the PDF. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Hand the PDF to the phone's share sheet.
   *
   * `canShare({ files })` is the only honest test - a browser can have
   * `navigator.share` and still refuse files, and calling share() without
   * checking throws in exactly that case. When files cannot be shared we do the
   * thing the customer actually wanted rather than a lesser version of it: save
   * the PDF. Sharing a LINK instead would be wrong twice over - the link needs
   * their session, so it would be useless to whoever received it.
   */
  async function share() {
    setBusy("share");
    setError(null);
    try {
      const res = await fetch(pdfUrl(), { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const blob = await res.blob();
      const file = new File([blob], filename, { type: "application/pdf" });
      const nav = navigator as Navigator & {
        canShare?: (data: { files?: File[] }) => boolean;
      };
      if (nav.canShare?.({ files: [file] }) && typeof navigator.share === "function") {
        await navigator.share({
          files: [file],
          title: report ? `${report.subjectName} — ${report.periodLabel}` : "ChairBack report",
        });
        return;
      }
      await download();
    } catch (err) {
      // A cancelled share sheet is not an error - the customer changed their
      // mind, and telling them something went wrong would be a small lie.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError("Couldn't share the PDF. Try downloading it instead.");
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * Print.
   *
   * Opens the PDF, not this page. Printing the dashboard would carry the
   * navigation, the buttons and the page's background effects onto paper, and
   * would depend on print CSS staying correct forever. The PDF is already the
   * document - one page, laid out for Letter and A4 - so printing it is both
   * simpler and exactly what the barber will get.
   */
  function print() {
    window.open(pdfUrl(), "_blank", "noopener,noreferrer");
  }

  const subjects = options?.subjects ?? [];
  const canPickSubject = Boolean(options && (options.canReportShop || subjects.length > 1));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="yearly-report-open"
        className="inline-flex items-center gap-2 rounded-xl border border-gold/30 bg-gold/10 px-3 py-2 text-sm font-medium text-gold transition-colors duration-150 hover:bg-gold/15"
      >
        <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4 fill-current">
          <path d="M5 2h7l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm7 1.5V6h2.5L12 3.5ZM6.5 9h7v1.5h-7V9Zm0 3h7v1.5h-7V12Zm0 3h4.5v1.5H6.5V15Z" />
        </svg>
        Yearly report
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Yearly report"
        subtitle="A one-page summary of your verified ChairBack numbers."
        className="max-w-2xl"
        footer={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={download}
              disabled={!report || busy !== null}
              className="flex-1 rounded-xl bg-gold px-4 py-2.5 text-sm font-semibold text-black transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50"
            >
              {busy === "download" ? "Preparing…" : "Download PDF"}
            </button>
            <button
              type="button"
              onClick={print}
              disabled={!report || busy !== null}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-offwhite transition-colors duration-150 hover:bg-white/5 disabled:opacity-50"
            >
              Print
            </button>
            <button
              type="button"
              onClick={share}
              disabled={!report || busy !== null}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-offwhite transition-colors duration-150 hover:bg-white/5 disabled:opacity-50"
            >
              {busy === "share" ? "Sharing…" : "Share"}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* The pickers. A barber sees no subject control at all - the API
              returns exactly one subject for him, so there is nothing to
              choose and a disabled dropdown would only raise the question. */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted">Year</span>
              <select
                value={year ?? ""}
                onChange={(e) => setYear(Number(e.target.value))}
                aria-label="Report year"
                data-testid="yearly-report-year"
                className="min-w-[9rem] rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-offwhite"
              >
                {(options?.years ?? []).map((y) => (
                  <option key={y} value={y}>
                    {y === options?.currentYear ? `${y} year to date` : y}
                  </option>
                ))}
              </select>
            </label>
            {canPickSubject && (
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted">Report for</span>
                <select
                  value={subject ?? ""}
                  onChange={(e) => setSubject(e.target.value)}
                  aria-label="Report subject"
                  data-testid="yearly-report-subject"
                  className="min-w-0 max-w-[14rem] truncate rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-offwhite"
                >
                  {options?.canReportShop && <option value="shop">Whole shop</option>}
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
          {loading && !report && <p className="text-sm text-muted">Building your report…</p>}

          {report && (
            <div
              ref={previewRef}
              data-testid="yearly-report-preview"
              className={loading ? "opacity-60 transition-opacity duration-150" : undefined}
            >
              <ReportPreview report={report} providerNoun={report.providerNoun || vocab.providerNoun} />
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

/**
 * The on-screen preview.
 *
 * Deliberately the same INFORMATION and the same ORDER as the printed page, in
 * the dashboard's own dark styling rather than a shrunken picture of the PDF. A
 * scaled-down page image is unreadable on a phone and tells the barber nothing
 * he can check; showing him the numbers he is about to print does.
 */
function ReportPreview({
  report,
  providerNoun,
}: {
  report: YearlyReportData;
  /** The shop's own word for a provider ("barber", "stylist", "nail tech"). */
  providerNoun: string;
}) {
  const t = report.totals;
  const peak = Math.max(...report.months.map((m) => m.revenueCents), 0);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-3">
        <div className="min-w-0">
          {/* min-w-0 + truncate: a long shop or barber name must shorten, not
              push the dates off the card. */}
          <h3 className="truncate font-display text-lg text-offwhite">{report.subjectName}</h3>
          <p className="truncate text-xs text-muted">
            {report.scope === "staff"
              ? `${cap(providerNoun)} at ${report.shopName}`
              : "Whole-shop performance summary"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-gold">{report.periodLabel}</p>
          <p className="text-[11px] text-muted">
            {prettyDay(report.rangeStart)} – {prettyDay(report.rangeEnd)}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* The label is FIXED, not the shop's service noun: the printed page
            says "Appointments completed", and the screen a barber checks it
            against must say the same words. A per-shop noun here would make
            the two documents describe the same number differently. */}
        <Tile label="Appointments completed" value={t.appointments.toLocaleString()} accent />
        <Tile label="Total revenue" value={moneyWhole(t.revenueCents)} />
        <Tile label="Clients served" value={t.uniqueClients.toLocaleString()} />
        <Tile
          label="Average ticket"
          value={t.avgTicketCents === null ? "—" : money(t.avgTicketCents)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile small label="New clients" value={t.newClients.toLocaleString()} />
        <Tile small label="Returning" value={t.returningClients.toLocaleString()} />
        <Tile small label="Return rate" value={percent(t.returnRateBp)} />
        <Tile small label="Avg monthly" value={moneyWhole(t.avgMonthlyRevenueCents)} />
        <Tile small label="No-shows" value={`${t.noShows} · ${percent(t.noShowRateBp)}`} />
        <Tile
          small
          label="Cancellations"
          value={`${t.cancellations} · ${percent(t.cancellationRateBp)}`}
        />
        <Tile small label="Busiest month" value={report.busiest.month ?? "—"} />
        <Tile small label="Busiest day" value={report.busiest.weekday ?? "—"} />
      </div>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Revenue by month
          </h4>
          <span className="text-[11px] text-muted">
            {peak > 0 ? `Peak ${moneyWhole(peak)}` : "No revenue in this range"}
          </span>
        </div>
        {/* Hand-rolled bars, the same approach as every other chart on this
            page - no chart library anywhere in this app. */}
        <div className="flex h-28 gap-1" role="img" aria-label="Revenue by month">
          {report.months.map((m) => (
            <div key={m.key} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
              {/* 🔴 The bar's percentage height must resolve against a box
                  with a DEFINITE height. The first version put `items-end` on
                  the row, so each column shrank to its content, every
                  percentage resolved to auto, and the chart rendered twelve
                  labels and no bars - in both themes, caught only by looking
                  at a screenshot. The column now stretches to the row's h-28
                  and this box takes the space above the label. */}
              <div className="flex w-full flex-1 items-end">
                <div
                  data-testid="month-bar"
                  className={`w-full rounded-t ${m.complete ? "bg-gold/70" : "bg-gold/30"}`}
                  style={{
                    height:
                      peak > 0 && m.revenueCents > 0
                        ? `${Math.max(3, (m.revenueCents / peak) * 100)}%`
                        : "0%",
                  }}
                  title={`${m.fullLabel}: ${money(m.revenueCents)} · ${m.appointments}`}
                />
              </div>
              <span className="text-[9px] text-muted">{m.label}</span>
            </div>
          ))}
        </div>
      </section>

      {report.services.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Most booked services
          </h4>
          <ul className="flex flex-col gap-1">
            {report.services.map((s) => (
              <li key={s.name} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-offwhite">{s.name}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {s.count} · {moneyWhole(s.revenueCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The honest unavailable state. Named, with the reason - an omitted row
          reads as a zero, and a zero reads as a fact. */}
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Not included
        </h4>
        <ul className="flex flex-col gap-1 text-[11px] text-muted">
          {report.scope === "staff" && report.syncedExcluded && (
            <li>
              Bookings synced from another calendar carry no {providerNoun}, so they are not in
              these numbers.
            </li>
          )}
          {report.unavailable.map((u) => (
            <li key={u.key}>
              <span className="text-offwhite/80">{u.label}:</span> {u.reason}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-[10px] text-muted">
        All amounts in {report.currency}. An appointment counts in the month it was scheduled
        for, in {report.timezone}. Operational performance summary. Not a tax return or audited
        financial statement.
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    // min-w-0 is load-bearing inside a grid: without it a long value refuses to
    // shrink and blows the column out instead of wrapping.
    <div
      className={`min-w-0 rounded-xl border p-3 ${
        accent ? "border-gold/25 bg-gold/[0.07]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      {/* Wraps rather than truncates: "APPOINTMENTS COMPLETED" does not fit a
          four-across tile at any phone width, and a headline label cut to
          "APPOINTMENTS COMPL…" is worse than a second line. The grid keeps
          each row's tiles the same height. */}
      <p className="text-[10px] uppercase leading-tight tracking-wide text-muted">{label}</p>
      <p
        className={`truncate font-semibold tabular-nums text-offwhite ${
          small ? "text-base" : "text-xl"
        }`}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
