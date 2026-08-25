"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import {
  NAME_WRAP_CLS,
  appointmentStatusPill,
  initialsOf,
} from "../_components/appointmentCardStyles";
import {
  AppointmentEditFields,
  useAppointmentEdit,
} from "./AppointmentEditForm";
import {
  checkoutAppointmentAction,
  getAppointmentDetailAction,
  type AppointmentDetail,
} from "./actions";
import type { AgendaRow } from "./page";

/** Same local alias the sibling booking forms use - the provider's own
 * `Toast` interface is a toast OBJECT and is not exported. */
type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * THE APPOINTMENT SHEET — one booking, everything true about it.
 *
 * Four views behind one dialog, in the order a barber actually needs them:
 *
 *   detail  → who it is, how to reach them, and what is owed
 *   edit    → the same booking, editable (native bookings only)
 *   charges → the ticket, itemised            ┐ the EXISTING chair-checkout
 *   pay     → amount + how it was paid        ┘ flow, unchanged
 *
 * 🔴 IT RIDES IN <Dialog>, AND THAT IS LOAD-BEARING. Dashboard cards use
 * `.glass`, which sets `backdrop-filter` — and a non-`none` backdrop-filter
 * makes that element the containing block for `position: fixed` descendants
 * AND a stacking context. A sheet rendered in place would size itself to the
 * CARD and paint underneath every later card on the page. Dialog portals to
 * `document.body` and owns the focus trap, focus restore, Escape, backdrop
 * click, scroll lock and the flex-none footer that never scrolls away.
 *
 * 🔴 WHAT IT REFUSES TO SAY. Payment comes from the API's payment engine and is
 * shown verbatim; where ChairBack did not take the money the sheet says so
 * ("Managed in Acuity", "No ChairBack payment recorded") rather than
 * characterizing a balance it cannot see. ChairBack persists no card data, so
 * a brand/last-four block renders only if a verified one ever arrives.
 *
 * 🔴 CONTACT NEVER LEAVES THE DEVICE ACTION. `tel:` / `sms:` / `mailto:` and
 * the clipboard are the only places a number or address goes. No toast, log,
 * analytics event or URL ever carries one — "Number copied" says nothing about
 * WHICH number, deliberately.
 */

export type SheetView = "detail" | "edit" | "charges" | "pay";

const METHODS = [
  { key: "cash" as const, label: "Cash", hint: "You keep 100%" },
  { key: "direct" as const, label: "Zelle · Venmo · Cash App", hint: "Sent to your handle" },
  { key: "card" as const, label: "Card", hint: "Your own reader" },
  { key: "other" as const, label: "Other", hint: "Comp, trade, split" },
];

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  direct: "Zelle · Venmo · Cash App",
  card: "Card",
  other: "Other",
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function AppointmentSheet({
  row,
  toast,
  onClose,
  onChanged,
  initialView = "detail",
}: {
  row: AgendaRow;
  toast: Toast;
  onClose: () => void;
  /** The agenda needs re-reading: a save, a checkout, anything that mutates. */
  onChanged: () => void;
  initialView?: SheetView;
}) {
  const [view, setView] = useState<SheetView>(initialView);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, start] = useTransition();

  // The booking's own record, fetched when the sheet opens rather than carried
  // on every agenda row — see getAppointmentDetailAction for why.
  const load = useCallback(() => {
    let alive = true;
    void (async () => {
      const res = await getAppointmentDetailAction(
        row.id,
        row.source === "visit" ? "visit" : "appointment",
      );
      if (!alive) return;
      if (res.ok && res.data) {
        setDetail(res.data);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [row.id, row.source]);
  useEffect(load, [load]);

  const edit = useAppointmentEdit({
    row,
    detail,
    toast,
    onSaved: () => {
      setView("detail");
      onChanged();
      load();
    },
  });

  // The shop's timezone is the only one an appointment time means anything in.
  const zone = detail?.timezone;
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }, []);
  const showZone = Boolean(zone && browserZone && zone !== browserZone);

  const dateLabel = useMemo(() => fmtDate(row.start, zone), [row.start, zone]);
  const timeLabel = useMemo(
    () => fmtTimeRange(row.start, row.end, zone),
    [row.start, row.end, zone],
  );
  const durMin =
    row.end && row.end > row.start
      ? Math.round((Date.parse(row.end) - Date.parse(row.start)) / 60_000)
      : null;

  const pay = detail?.payment ?? null;
  const ticketCents = pay?.totalCents ?? (row.price != null ? Math.round(row.price * 100) : null);
  const prepaidCents = pay?.onlineCents ?? Math.round((row.prepaid ?? 0) * 100);
  const owedCents =
    pay?.remainingCents ??
    (ticketCents === null ? null : Math.max(0, ticketCents - prepaidCents));

  // The chair-checkout endpoint accepts BOOKED and COMPLETED and is idempotent
  // (a second attempt 409s), so the button appears only where it would work.
  const canCheckout =
    detail !== null &&
    detail.source === "appointment" &&
    detail.origin === "chairback" &&
    (detail.status === "upcoming" || detail.status === "completed") &&
    detail.checkedOutAt === null;

  //  ── checkout step 3: how it was paid ────────────────────────────────────
  const [amount, setAmount] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]["key"] | null>(null);
  const parsedAmount = Number.parseFloat(amount ?? "");
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const amountValue = amount ?? ((owedCents ?? 0) / 100).toFixed(2);

  function submitCheckout() {
    if (!method || !amountValid) return;
    start(async () => {
      const res = await checkoutAppointmentAction(row.id, {
        amount: Number(parsedAmount.toFixed(2)),
        method,
      });
      if (!res.ok) {
        // The 409 is the double-tap guard and deserves its own words: the money
        // DID land, so "try again" would be exactly the wrong advice.
        toast(
          res.error === "paid_already"
            ? "This cut was already checked out"
            : "Couldn't save the checkout",
          "error",
        );
        return;
      }
      toast(`Paid $${parsedAmount.toFixed(2)} · ${row.clientName}`, "success");
      onChanged();
      onClose();
    });
  }

  //  ── chrome ──────────────────────────────────────────────────────────────
  const title =
    view === "edit"
      ? row.status === "pending"
        ? "Edit request"
        : "Edit appointment"
      : view === "detail"
        ? "Appointment"
        : "Checkout";

  const footer =
    view === "edit" ? (
      <EditFooter
        pending={edit.pending}
        disabled={!edit.ctx}
        onCancel={() => setView("detail")}
        onSave={edit.save}
      />
    ) : view === "charges" ? (
      <TwoUp
        secondary={{ label: "Back", onClick: () => setView("detail") }}
        primary={{ label: "Next", onClick: () => setView("pay") }}
      />
    ) : view === "pay" ? (
      <TwoUp
        secondary={{ label: "Back", onClick: () => setView("charges") }}
        primary={{
          label: pending
            ? "Saving…"
            : method
              ? `Mark paid · $${amountValid ? parsedAmount.toFixed(2) : "—"}`
              : "Pick a payment method",
          onClick: submitCheckout,
          disabled: pending || !method || !amountValid,
        }}
      />
    ) : (
      <DetailFooter detail={detail} onEdit={() => setView("edit")} />
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={footer}
      className="sm:max-w-xl lg:max-w-3xl xl:max-w-4xl"
    >
      {view === "edit" ? (
        <AppointmentEditFields state={edit} />
      ) : view === "charges" ? (
        <ChargesView
          row={row}
          detail={detail}
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          ticketCents={ticketCents}
          prepaidCents={prepaidCents}
          owedCents={owedCents}
        />
      ) : view === "pay" ? (
        <PayView
          row={row}
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          amount={amountValue}
          setAmount={setAmount}
          amountValid={amountValid}
          prepaidCents={prepaidCents}
          ticketCents={ticketCents}
          method={method}
          setMethod={setMethod}
        />
      ) : (
        <DetailView
          row={row}
          detail={detail}
          loadError={loadError}
          onRetry={load}
          toast={toast}
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          durMin={durMin}
          showZone={showZone}
          canCheckout={canCheckout}
          onCheckout={() => setView("charges")}
        />
      )}
    </Dialog>
  );
}

//  ── the detail view ───────────────────────────────────────────────────────

function DetailView({
  row,
  detail,
  loadError,
  onRetry,
  toast,
  dateLabel,
  timeLabel,
  durMin,
  showZone,
  canCheckout,
  onCheckout,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  loadError: boolean;
  onRetry: () => void;
  toast: Toast;
  dateLabel: string;
  timeLabel: string;
  durMin: number | null;
  showZone: boolean;
  canCheckout: boolean;
  onCheckout: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Hero row={row} detail={detail} timeLabel={timeLabel} dateLabel={dateLabel} />

      {loadError && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger-soft/40 bg-danger-soft/5 px-3.5 py-2.5 text-xs text-danger-soft"
        >
          Couldn&apos;t load this booking&apos;s contact and payment details.
          <button
            type="button"
            onClick={onRetry}
            className="h-11 rounded-lg border border-danger-soft/40 px-3 text-xs font-medium transition-colors duration-150 ease-out hover:bg-danger-soft/10 sm:h-8"
          >
            Try again
          </button>
        </p>
      )}

      {/* Two columns once there is room: reaching the client on the left, the
          booking's own facts on the right, and PAYMENT spanning both underneath
          so the money reads as its own moment rather than as the tail of a
          column. Below `lg` it is one clean stack in the same order — who, how
          to reach them, what the booking is, what is owed. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ContactCard detail={detail} loadError={loadError} toast={toast} />
        <DetailsCard
          row={row}
          detail={detail}
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          durMin={durMin}
          showZone={showZone}
        />
        <div className="lg:col-span-2">
          <PaymentCard
            detail={detail}
            loadError={loadError}
            canCheckout={canCheckout}
            onCheckout={onCheckout}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * THE HERO. The client's name is the strongest thing on the screen, on its own
 * full-width line, wrapping rather than truncating — "Ab…" is the one failure
 * this whole surface exists to prevent. A thin status rail runs the left edge,
 * tinted from the SAME table as the pill so the two can never disagree.
 */
function Hero({
  row,
  detail,
  timeLabel,
  dateLabel,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  timeLabel: string;
  dateLabel: string;
}) {
  const pill = appointmentStatusPill({
    status: row.status,
    checkInStatus: row.checkInStatus,
    etaMinutes: row.etaMinutes,
    runningLate: row.runningLate,
  });
  const external = detail ? detail.origin === "external" : Boolean(row.syncedExternal);
  const sourceLabel = detail?.originLabel ?? (row.syncedExternal ? "Acuity" : "ChairBack");
  const barber = detail?.staffName ?? null;
  const service = detail?.serviceName ?? row.serviceName;

  return (
    <section className="relative overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/60 pl-4 pr-3.5 py-4 sm:pl-5 sm:pr-5 sm:py-5">
      {/* The status rail. Thin, brass-weight, and the first thing read. */}
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-[3px] rounded-r-full", pill.railCls)}
      />
      {/* A barber's fine parallel lines, at a weight you notice only as texture.
          Masked to fade out toward the name so it never competes with it, and
          so the pattern has no hard edge mid-card. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-3/5 text-offwhite opacity-[0.03]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(112deg, currentColor 0 1px, transparent 1px 11px)",
          maskImage: "linear-gradient(to right, transparent, black 65%)",
          WebkitMaskImage: "linear-gradient(to right, transparent, black 65%)",
        }}
      />

      <div className="relative flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-charcoal-700 font-display text-base text-offwhite/85 ring-1 ring-white/10"
        >
          {initialsOf(row.clientName || "Client")}
        </span>
        <div className="min-w-0 flex-1">
          {detail?.clientId ? (
            <Link
              href={`/dashboard/clients/${detail.clientId}`}
              className={cn(
                NAME_WRAP_CLS,
                // The name is also the way through to the client's page, so it
                // is a real touch target: a single-line name is only 26px tall,
                // and the padding takes its hit box past 44 while the negative
                // margin keeps the hero's spacing exactly as designed.
                "-my-2.5 block py-2.5 font-display text-[21px] font-normal leading-tight transition-colors duration-150 ease-out hover:text-gold sm:-my-0 sm:py-0 sm:text-2xl",
              )}
            >
              {row.clientName || "Client"}
            </Link>
          ) : (
            <h3
              className={cn(
                NAME_WRAP_CLS,
                "font-display text-[21px] font-normal leading-tight sm:text-2xl",
              )}
            >
              {row.clientName || "Client"}
            </h3>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
                pill.cls,
              )}
            >
              {pill.label}
            </span>
            {/* SOURCE, not status. A synced booking is just as booked as a
                native one; what differs is who owns it. */}
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[10px] font-medium",
                external
                  ? "bg-sky-400/15 text-sky-300"
                  : "bg-charcoal-700 text-muted",
              )}
            >
              {sourceLabel}
            </span>
            {row.seriesId && (
              <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-[10px] font-medium text-gold">
                ↻ Weekly
              </span>
            )}
          </div>
        </div>
      </div>

      {/* TWO deterministic lines rather than one wrapping run of separators.
          A single flex row of "a · b · c · d" puts a "·" at the end of a line
          at one width and at the START of the next line at another; both read
          as a glitch. What it is goes on one line, when it is on the other,
          and the only separator left sits between two items that fit together
          at 320px. */}
      <div className="relative mt-3.5 flex flex-col gap-1 text-xs leading-relaxed">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="[overflow-wrap:anywhere] text-offwhite/85">
            {service ?? "Appointment"}
          </span>
          {barber && (
            <span className="[overflow-wrap:anywhere] text-muted">with {barber}</span>
          )}
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted">
          <span className="whitespace-nowrap tabular-nums">{dateLabel}</span>
          <span className="whitespace-nowrap tabular-nums">
            <span aria-hidden className="mr-2 text-muted/50">
              ·
            </span>
            {timeLabel}
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * REACH YOUR CLIENT. Every action here is a device handoff — a `tel:`, an
 * `sms:`, a `mailto:` or the clipboard — so a channel with nothing behind it
 * simply is not rendered. An action that disappears is better than one that
 * fails in the barber's hand, and far better than a row of dead grey boxes.
 */
function ContactCard({
  detail,
  loadError,
  toast,
}: {
  detail: AppointmentDetail | null;
  loadError: boolean;
  toast: Toast;
}) {
  const [copied, setCopied] = useState<"phone" | "email" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (kind: "phone" | "email", value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(kind);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1800);
        // Deliberately says nothing about WHICH number: a contact detail must
        // never ride in a toast, a log line or an analytics event.
        toast(kind === "phone" ? "Number copied" : "Email copied", "success");
      } catch {
        toast("Couldn't copy — press and hold to select it instead", "error");
      }
    },
    [toast],
  );

  if (loadError) return null;
  if (!detail) return <CardSkeleton title="Reach your client" rows={2} />;

  const { phone, phoneDisplay, email } = detail.contact;
  const nothing = !phone && !email;

  return (
    // `h-full` + a column layout so that when this card shares a desktop row
    // with the taller details card, the numbers settle against its bottom edge
    // instead of leaving a hole under a short card.
    <Panel title="Reach your client" className="flex h-full flex-col">
      {nothing ? (
        <p className="text-xs leading-relaxed text-muted">
          No phone or email on file for this booking. Add one from Edit and every
          action here turns on.
        </p>
      ) : (
        <>
          {/* A compact wrapping grid: two up at 320, three from 420 and in the
              desktop column, so five actions never leave a lonely orphan row. */}
          <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
            {phone && (
              <>
                <ContactAction as="a" href={`tel:${phone}`} icon={<PhoneIcon />} label="Call" />
                <ContactAction as="a" href={`sms:${phone}`} icon={<ChatIcon />} label="Text" />
              </>
            )}
            {email && (
              <ContactAction
                as="a"
                href={`mailto:${email}`}
                icon={<MailIcon />}
                label="Email"
              />
            )}
            {phone && (
              <ContactAction
                onClick={() => void copy("phone", phone)}
                icon={copied === "phone" ? <CheckIcon /> : <CopyIcon />}
                label={copied === "phone" ? "Copied" : "Copy number"}
                active={copied === "phone"}
              />
            )}
            {email && (
              <ContactAction
                onClick={() => void copy("email", email)}
                icon={copied === "email" ? <CheckIcon /> : <CopyIcon />}
                label={copied === "email" ? "Copied" : "Copy email"}
                active={copied === "email"}
              />
            )}
          </div>

          <dl className="mt-3 flex flex-col gap-1 border-t border-subtle pt-3 text-xs lg:mt-auto">
            {phone && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-muted">Phone</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere] tabular-nums text-offwhite/85">
                  {phoneDisplay ?? phone}
                </dd>
              </div>
            )}
            {email && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-muted">Email</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere] text-offwhite/85">{email}</dd>
              </div>
            )}
          </dl>

          {/* Announced for screen readers without moving focus off the button. */}
          <span role="status" aria-live="polite" className="sr-only">
            {copied === "phone"
              ? "Phone number copied to clipboard"
              : copied === "email"
                ? "Email address copied to clipboard"
                : ""}
          </span>
        </>
      )}
    </Panel>
  );
}

/** APPOINTMENT DETAILS — scannable icon rows, one fact each. */
function DetailsCard({
  row,
  detail,
  dateLabel,
  timeLabel,
  durMin,
  showZone,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  dateLabel: string;
  timeLabel: string;
  durMin: number | null;
  showZone: boolean;
}) {
  const addOns = detail?.addOns ?? row.addOns ?? [];
  const price = detail?.price ?? row.price;
  return (
    <Panel title="Appointment details" className="h-full">
      <dl className="flex flex-col">
        <Row icon={<CalendarIcon />} label="Date" value={dateLabel} />
        <Row
          icon={<ClockIcon />}
          label="Time"
          value={durMin ? `${timeLabel} · ${durMin} min` : timeLabel}
        />
        {detail?.staffName && (
          <Row icon={<ScissorsIcon />} label="Barber" value={detail.staffName} />
        )}
        <Row
          icon={<TagIcon />}
          label="Service"
          value={detail?.serviceName ?? row.serviceName ?? "Appointment"}
        >
          {addOns.length > 0 && (
            <span className="mt-0.5 block text-[11px] text-muted">
              {addOns.map((a) => `+ ${a.name}`).join(" · ")}
            </span>
          )}
        </Row>
        <Row
          icon={<CashIcon />}
          label="Price"
          value={price != null ? `$${price.toFixed(2)}` : "Not priced"}
        />
        {/* Only when it would change what the barber reads above: a shop whose
            timezone matches the browser's needs no extra line. */}
        {showZone && detail && (
          <Row icon={<GlobeIcon />} label="Timezone" value={detail.timezone} />
        )}
        {detail?.notes && (
          <Row icon={<NoteIcon />} label="Note" value={detail.notes} muted />
        )}
      </dl>
    </Panel>
  );
}

/**
 * PAYMENT. The number a barber needs at the chair is what is still owed, so
 * that is the big one. Everything under it is only what ChairBack can prove;
 * where it cannot, it says who can.
 */
function PaymentCard({
  detail,
  loadError,
  canCheckout,
  onCheckout,
}: {
  detail: AppointmentDetail | null;
  loadError: boolean;
  canCheckout: boolean;
  onCheckout: () => void;
}) {
  if (loadError) return null;
  if (!detail) return <CardSkeleton title="Payment" rows={3} />;

  const p = detail.payment;
  const external = p.state === "external";
  const settled = p.state === "paid";

  const eyebrow = external
    ? `Managed in ${detail.originLabel}`
    : p.state === "paid"
      ? "Settled"
      : p.state === "refunded"
        ? "Refunded"
        : p.state === "deposit"
          ? "Part paid"
          : "Ready for checkout";

  const headline = external
    ? "Managed externally"
    : settled
      ? "Paid in full"
      : p.state === "refunded"
        ? money(p.refundedCents)
        : p.remainingCents === null
          ? "No price set"
          : money(p.remainingCents);

  // A currency headline can carry the display face at full size; a SENTENCE
  // ("Managed externally") at 30px swallows the card, so it steps down.
  const numeric = headline.startsWith("$");

  return (
    <Panel title="Payment">
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:items-start">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            {eyebrow}
          </p>
          <p
            className={cn(
              "mt-1 font-display leading-tight [overflow-wrap:anywhere]",
              numeric ? "text-3xl tabular-nums" : "text-xl",
              external
                ? "text-muted"
                : settled
                  ? "text-emerald-soft"
                  : p.state === "refunded"
                    ? "text-danger-soft"
                    : "text-offwhite",
            )}
          >
            {headline}
          </p>
          {!external && !settled && p.remainingCents !== null && p.remainingCents > 0 && (
            <p className="mt-1 text-[11px] text-muted">still to collect</p>
          )}
        </div>

      {external ? (
        <p className="rounded-xl border border-subtle bg-charcoal-900/50 px-3 py-2.5 text-xs leading-relaxed text-muted">
          No ChairBack payment recorded. {detail.originLabel} took this booking, so
          whether a deposit or the full ticket was paid is only visible there.
        </p>
      ) : (
        <dl className="flex flex-col gap-1.5 border-t border-subtle pt-3 text-xs sm:border-t-0 sm:pt-0">
          <Line
            label="Ticket total"
            value={p.totalCents === null ? "—" : money(p.totalCents)}
          />
          {p.onlineCents > 0 && (
            <Line label="Paid online" value={money(p.onlineCents)} tone="good" />
          )}
          {p.inPersonCents > 0 && (
            <Line
              label={
                p.method ? `At the chair · ${METHOD_LABEL[p.method] ?? p.method}` : "At the chair"
              }
              value={money(p.inPersonCents)}
              tone="good"
            />
          )}
          {/* A comped cut: settled, with nothing collected. Saying so beats a
              payment card that shows a total and no money against it. */}
          {settled && p.collectedCents === 0 && (
            <Line
              label={p.method ? `Comped · ${METHOD_LABEL[p.method] ?? p.method}` : "Comped"}
              value={money(0)}
            />
          )}
          {p.refundedCents > 0 && (
            <Line label="Refunded" value={`−${money(p.refundedCents)}`} tone="bad" />
          )}
          {/* An authorization is a card being HELD, not money in the shop. */}
          {p.authorizedCents > 0 && (
            <Line label="Card held (not captured)" value={money(p.authorizedCents)} />
          )}
          {/* ChairBack persists no card data, so this renders only if a
              verified brand/last-four ever reaches the payload. */}
          {p.card && (
            <Line
              label="Card"
              value={`${p.card.brand} ···· ${p.card.last4}`}
            />
          )}
        </dl>
      )}
      </div>

      {(canCheckout || p.receiptUrl) && (
        <div className="mt-3.5 flex flex-col gap-2 border-t border-subtle pt-3.5 sm:flex-row sm:items-center">
          {canCheckout && (
            <button
              type="button"
              onClick={onCheckout}
              className="flex h-11 flex-none items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted sm:min-w-[12rem]"
            >
              {p.collectedCents > 0 ? "Collect the rest" : "Start checkout"}
            </button>
          )}
          {p.receiptUrl && (
            <a
              href={p.receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-11 flex-none items-center justify-center rounded-xl border border-subtle px-5 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              View receipt
            </a>
          )}
        </div>
      )}
    </Panel>
  );
}

//  ── checkout steps (the existing flow, unchanged in behavior) ─────────────

function ChargesView({
  row,
  detail,
  dateLabel,
  timeLabel,
  ticketCents,
  prepaidCents,
  owedCents,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  dateLabel: string;
  timeLabel: string;
  ticketCents: number | null;
  prepaidCents: number;
  owedCents: number | null;
}) {
  const addOns = detail?.addOns ?? row.addOns ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Charges">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            <p className="[overflow-wrap:anywhere] text-sm font-medium text-offwhite">
              {detail?.serviceName ?? row.serviceName ?? "Appointment"}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {dateLabel} · {timeLabel}
            </p>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-offwhite">
            {ticketCents === null ? "—" : money(ticketCents)}
          </span>
        </div>
        {/* Add-ons are folded into the ticket price at booking, so they are
            itemised for the barber's eyes and never re-added. */}
        {addOns.length > 0 && (
          <ul className="mt-2 border-t border-subtle pt-2">
            {addOns.map((a) => (
              <li key={a.id} className="py-0.5 text-xs text-muted">
                + {a.name}
              </li>
            ))}
            <li className="pt-1 text-[10px] text-muted/70">Included in the price above</li>
          </ul>
        )}
      </Panel>

      {prepaidCents > 0 && (
        <div className="flex flex-wrap justify-between gap-2 rounded-xl border border-emerald-soft/30 bg-emerald-soft/5 px-4 py-3 text-sm">
          <span className="text-emerald-soft">Already paid online</span>
          <span className="tabular-nums text-emerald-soft">−{money(prepaidCents)}</span>
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-subtle pt-3">
        <span className="text-sm text-muted">Due now</span>
        <span className="font-display text-2xl tabular-nums text-offwhite">
          {money(owedCents ?? 0)}
        </span>
      </div>
    </div>
  );
}

function PayView({
  row,
  dateLabel,
  timeLabel,
  amount,
  setAmount,
  amountValid,
  prepaidCents,
  ticketCents,
  method,
  setMethod,
}: {
  row: AgendaRow;
  dateLabel: string;
  timeLabel: string;
  amount: string;
  setAmount: (v: string) => void;
  amountValid: boolean;
  prepaidCents: number;
  ticketCents: number | null;
  method: string | null;
  setMethod: (m: (typeof METHODS)[number]["key"]) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-subtle bg-charcoal-800/40 px-4 py-3 text-center text-xs text-muted">
        <p className="[overflow-wrap:anywhere] font-medium text-offwhite">{row.clientName}</p>
        <p className="mt-0.5">
          {dateLabel} · {timeLabel}
        </p>
      </div>

      <div className="py-2 text-center">
        <label className="sr-only" htmlFor="checkout-amount">
          Amount collected
        </label>
        <div className="flex items-center justify-center gap-1">
          <span className="font-display text-3xl text-muted">$</span>
          <input
            id="checkout-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!amountValid || undefined}
            className="w-40 bg-transparent text-center font-display text-5xl tabular-nums text-offwhite outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
          />
        </div>
        {!amountValid ? (
          <p role="alert" className="mt-1 text-xs text-danger-soft">
            Enter an amount.
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">
            {prepaidCents > 0
              ? `${money(prepaidCents)} already paid online · ${
                  ticketCents === null ? "no" : money(ticketCents)
                } ticket`
              : "Tap to change — tips and discounts go here"}
          </p>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          How did they pay?
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMethod(m.key)}
              aria-pressed={method === m.key}
              className={cn(
                "flex min-h-[2.75rem] flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors duration-150 ease-out",
                method === m.key
                  ? "border-gold/50 bg-gold/10 text-gold"
                  : "border-subtle text-offwhite hover:border-subtle-strong",
              )}
            >
              <span className="font-medium">{m.label}</span>
              <span
                className={cn("text-[11px]", method === m.key ? "text-gold/80" : "text-muted")}
              >
                {m.hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      <p className="text-center text-[11px] leading-relaxed text-muted">
        Records the sale and marks the cut done. ChairBack never touches the money —
        you keep 100%.
      </p>
    </div>
  );
}

//  ── footers ───────────────────────────────────────────────────────────────

/**
 * The detail view's footer is deliberately QUIET: the sheet's one solid-gold
 * action is Start checkout, and it lives in the payment card next to the
 * number it acts on. A second bright button here would compete with it.
 */
function DetailFooter({
  detail,
  onEdit,
}: {
  detail: AppointmentDetail | null;
  onEdit: () => void;
}) {
  if (!detail) return null;
  if (detail.editable) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite sm:w-auto sm:px-6"
      >
        <PencilIcon />
        Edit appointment
      </button>
    );
  }
  // Read-only, and it says WHY rather than leaving a dead sheet: a booking
  // another system owns is changed there, and this card mirrors it.
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[11px] leading-relaxed text-muted">
        {detail.readOnlyReason === "external"
          ? `Booked in ${detail.originLabel}. Change or cancel it there — this sheet mirrors it so the time stays blocked here.`
          : "This booking is closed, so it can no longer be edited."}
      </p>
      {detail.externalManageUrl && (
        <a
          href={detail.externalManageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 shrink-0 items-center justify-center rounded-xl border border-sky-400/40 px-4 text-sm font-medium text-sky-300 transition-colors duration-150 ease-out hover:bg-sky-400/10"
        >
          Edit in {detail.originLabel}
        </a>
      )}
    </div>
  );
}

function EditFooter({
  pending,
  disabled,
  onCancel,
  onSave,
}: {
  pending: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <TwoUp
      secondary={{ label: "Cancel", onClick: onCancel, disabled: pending }}
      primary={{
        label: pending ? "Saving…" : "Save changes",
        onClick: onSave,
        disabled: pending || disabled,
      }}
    />
  );
}

/**
 * A quiet secondary and ONE solid-gold primary.
 *
 * Stacked only where it has to be: two full-height buttons eat ~150px of a
 * phone screen, so they sit side by side from 380px up and 320 gets the stack.
 * `flex-col-reverse` keeps the PRIMARY on top when stacked — the thumb lands
 * there first, and a Cancel above a Save is a mis-tap waiting to happen.
 *
 * 🔴 `flex-none` on both is load-bearing: `flex-1` in a COLUMN container makes
 * flex-basis the HEIGHT, which overrides `h-11` and collapses a stacked button
 * to 20px. The primary only grows once the container is a ROW.
 */
function TwoUp({
  secondary,
  primary,
}: {
  secondary: { label: string; onClick: () => void; disabled?: boolean };
  primary: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className="flex w-full flex-col-reverse gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-end">
      <button
        type="button"
        onClick={secondary.onClick}
        disabled={secondary.disabled}
        className="flex h-11 flex-none items-center justify-center rounded-xl border border-subtle px-5 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
      >
        {secondary.label}
      </button>
      <button
        type="button"
        onClick={primary.onClick}
        disabled={primary.disabled}
        className="flex h-11 flex-none items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50 min-[380px]:flex-1 sm:max-w-[16rem]"
      >
        {primary.label}
      </button>
    </div>
  );
}

//  ── small pieces ──────────────────────────────────────────────────────────

function Panel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4",
        className,
      )}
    >
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
        {title}
      </h3>
      {children}
    </section>
  );
}

function CardSkeleton({ title, rows }: { title: string; rows: number }) {
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: rows }).map((_, i) => (
          <span key={i} className="h-4 w-full rounded bg-charcoal-700/70" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </Panel>
  );
}

function ContactAction({
  as,
  href,
  onClick,
  icon,
  label,
  active,
}: {
  as?: "a";
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  const cls = cn(
    // 44px target, and the label wraps rather than clipping at 320px.
    "flex min-h-[2.75rem] min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-[11px] font-medium leading-tight transition-colors duration-150 ease-out",
    active
      ? "border-emerald-soft/45 bg-emerald-soft/10 text-emerald-soft"
      : "border-subtle text-offwhite/85 hover:border-gold/40 hover:text-gold",
  );
  if (as === "a" && href) {
    return (
      <a href={href} className={cls}>
        {icon}
        <span className="[overflow-wrap:anywhere]">{label}</span>
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {icon}
      <span className="[overflow-wrap:anywhere]">{label}</span>
    </button>
  );
}

function Row({
  icon,
  label,
  value,
  muted,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  muted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-subtle/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-gold/70">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-medium uppercase tracking-wide text-muted">
          {label}
        </dt>
        <dd
          className={cn(
            "mt-0.5 [overflow-wrap:anywhere] text-sm leading-snug",
            muted ? "text-offwhite/75" : "text-offwhite",
          )}
        >
          {value}
          {children}
        </dd>
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="min-w-0 [overflow-wrap:anywhere] text-muted">{label}</dt>
      <dd
        className={cn(
          "shrink-0 tabular-nums",
          tone === "good"
            ? "text-emerald-soft"
            : tone === "bad"
              ? "text-danger-soft"
              : "text-offwhite/85",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

//  ── formatting ────────────────────────────────────────────────────────────

function fmtDate(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

function fmtTimeRange(startIso: string, endIso: string | null, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  const s = fmt.format(new Date(startIso));
  const e = endIso ? fmt.format(new Date(endIso)) : null;
  return e ? `${s}–${e}` : s;
}

//  ── icons ─────────────────────────────────────────────────────────────────

function Svg({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const PhoneIcon = () => (
  <Svg size={18}>
    <path d="M5 4h3l2 5-2.5 1.5a12 12 0 0 0 5.5 5.5L15 13.5l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
  </Svg>
);
const ChatIcon = () => (
  <Svg size={18}>
    <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12Z" />
  </Svg>
);
const MailIcon = () => (
  <Svg size={18}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </Svg>
);
const CopyIcon = () => (
  <Svg size={18}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Svg>
);
const CheckIcon = () => (
  <Svg size={18}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Svg>
);
const CalendarIcon = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);
const ClockIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
/** Barber-inspired, not a barber pole: the shears themselves. */
const ScissorsIcon = () => (
  <Svg>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M8 7.5 20 18M8 16.5 20 6" />
  </Svg>
);
const TagIcon = () => (
  <Svg>
    <path d="M3 12V4h8l9 9-8 8-9-9Z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </Svg>
);
const CashIcon = () => (
  <Svg>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
);
const GlobeIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
  </Svg>
);
const NoteIcon = () => (
  <Svg>
    <path d="M5 3h9l5 5v13H5z" />
    <path d="M14 3v5h5M8.5 13h7M8.5 17h4" />
  </Svg>
);
const PencilIcon = () => (
  <Svg size={14}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);
