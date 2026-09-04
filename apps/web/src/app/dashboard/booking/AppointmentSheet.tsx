"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import { INPUT } from "./formkit";
import {
  NAME_WRAP_CLS,
  appointmentStatusPill,
  initialsOf,
  type AppointmentCardStatus,
} from "../_components/appointmentCardStyles";
import {
  AppointmentEditFields,
  useAppointmentEdit,
} from "./AppointmentEditForm";
import {
  cancelAppointmentAction,
  checkoutAppointmentAction,
  completeAppointmentAction,
  updateAppointmentPriceAction,
  getAppointmentDetailAction,
  markArrivedAction,
  noShowAppointmentAction,
  type AppointmentDetail,
  type DetailHistoryItem,
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
 *   detail  → who it is, what the booking is, what is owed, what to do next
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
 * analytics event or URL ever carries one — "Phone number copied" says nothing
 * about WHICH number, deliberately. And Text is only a live action where the
 * shop may actually text: consent is a gate, not a formality.
 */

export type SheetView = "detail" | "edit" | "charges" | "pay";

/** Which action surface is open over the sheet, if any. */
type MenuKind = "contact" | "more" | null;

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
  const vocab = useVocab();
  const [view, setView] = useState<SheetView>(initialView);
  const [menu, setMenu] = useState<MenuKind>(null);
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
  const zoneDiffers = Boolean(zone && browserZone && zone !== browserZone);

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
            ? `This ${vocab.serviceNoun} was already checked out`
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

  /**
   * A status transition from the More menu. Every one of these is the SAME
   * endpoint the appointment card already calls — the sheet is a second door
   * onto them, never a second set of rules.
   */
  function act(
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
    closeAfter = false,
  ) {
    setMenu(null);
    start(async () => {
      const res = await fn(row.id);
      if (!res.ok) {
        toast("That didn't go through", "error");
        return;
      }
      toast(label, "success");
      onChanged();
      if (closeAfter) onClose();
      else load();
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

  const back =
    view === "detail"
      ? null
      : {
          detail: () => setView("detail"),
          edit: () => setView("detail"),
          charges: () => setView("detail"),
          pay: () => setView("charges"),
        }[view];

  /**
   * ESCAPE AND THE BACKDROP CLOSE THE TOPMOST THING, not always the sheet.
   * Dialog owns both, so the menus can only get their turn by intercepting
   * here — otherwise hitting Escape over an open Contact menu would throw away
   * the whole booking sheet underneath it.
   */
  function closeTopmost() {
    if (menu) {
      setMenu(null);
      return;
    }
    onClose();
  }

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
      onClose={closeTopmost}
      title={title}
      titleAlign="center"
      // Each view is its own page and starts at its own top.
      scrollResetKey={view}
      leading={
        back ? (
          <button
            type="button"
            onClick={back}
            data-qa="sheet-back"
            className="-ml-1 flex h-11 min-w-[2.75rem] items-center justify-center rounded-full border border-subtle px-3 text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </button>
        ) : null
      }
      footer={footer}
      className="sm:max-w-lg lg:max-w-3xl"
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
          zoneDiffers={zoneDiffers}
          browserZone={browserZone}
          canCheckout={canCheckout}
          busy={pending}
          menu={menu}
          setMenu={setMenu}
          onEdit={() => setView("edit")}
          onCheckout={() => setView("charges")}
          onAct={act}
          onPriceSaved={() => {
            onChanged();
            load();
          }}
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
  zoneDiffers,
  browserZone,
  canCheckout,
  busy,
  menu,
  setMenu,
  onEdit,
  onCheckout,
  onAct,
  onPriceSaved,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  loadError: boolean;
  onRetry: () => void;
  toast: Toast;
  dateLabel: string;
  timeLabel: string;
  durMin: number | null;
  zoneDiffers: boolean;
  browserZone: string | null;
  canCheckout: boolean;
  busy: boolean;
  menu: MenuKind;
  setMenu: (m: MenuKind) => void;
  onEdit: () => void;
  onCheckout: () => void;
  onAct: (
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
    closeAfter?: boolean,
  ) => void;
  /** The price changed on the server: re-read the booking and the agenda. */
  onPriceSaved: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Hero
        row={row}
        detail={detail}
        dateLabel={dateLabel}
        timeLabel={timeLabel}
        durMin={durMin}
        toast={toast}
        onPriceSaved={onPriceSaved}
      />

      <ActionRow
        detail={detail}
        busy={busy}
        onContact={() => setMenu("contact")}
        onReschedule={onEdit}
        onMore={() => setMenu("more")}
      />

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

      {/* Two balanced columns once there is room: the money on the left, the
          things a barber reads ABOUT the client on the right. Below `lg` it is
          one stack in the same order. `items-start` so a short column does not
          stretch its cards to match a tall one. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <PaymentCard
            detail={detail}
            loadError={loadError}
            canCheckout={canCheckout}
            onCheckout={onCheckout}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <ClientCard
            detail={detail}
            loadError={loadError}
            zoneDiffers={zoneDiffers}
            browserZone={browserZone}
          />
          {detail?.notes && (
            <Panel title="Note">
              <p className="[overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-relaxed text-offwhite/85">
                {detail.notes}
              </p>
            </Panel>
          )}
          <HistoryCard detail={detail} />
        </div>
      </div>

      {menu === "contact" && detail && (
        <ContactMenu detail={detail} toast={toast} onClose={() => setMenu(null)} />
      )}
      {menu === "more" && detail && (
        <MoreMenu
          row={row}
          detail={detail}
          onClose={() => setMenu(null)}
          onEdit={() => {
            setMenu(null);
            onEdit();
          }}
          onAct={onAct}
        />
      )}
    </div>
  );
}

/**
 * THE HERO. A centered identity block — avatar, then the client's full name as
 * the strongest thing on the screen, wrapping rather than truncating ("Ab…" is
 * the one failure this whole surface exists to prevent), then the two badges
 * that answer different questions: what STATE the booking is in, and WHO owns
 * it. Under a hairline, the booking's own facts.
 *
 * The status accent is a tinted ring on the avatar rather than a colored card:
 * one small deliberate signal instead of a block of color that would fight the
 * name for the eye.
 */
function Hero({
  row,
  detail,
  dateLabel,
  timeLabel,
  durMin,
  toast,
  onPriceSaved,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  dateLabel: string;
  timeLabel: string;
  durMin: number | null;
  toast: Toast;
  onPriceSaved: () => void;
}) {
  const vocab = useVocab();
  const priceEdit = usePriceEdit({ row, detail, toast, onSaved: onPriceSaved });
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
  const price = detail?.price ?? row.price;
  const name = row.clientName || "Client";

  return (
    <section className="relative overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/60">
      {/* A barber's straight razor line: one brass hairline across the top,
          fading out at both ends so it reads as a finish, not a border. */}
      <span
        aria-hidden
        className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-gold/45 to-transparent"
      />
      {/* Fine parallel lines at a weight you notice only as texture, masked so
          the pattern never has a hard edge and never competes with the name. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-28 text-offwhite opacity-[0.035]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(112deg, currentColor 0 1px, transparent 1px 11px)",
          maskImage: "linear-gradient(to bottom, black, transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, black, transparent)",
        }}
      />

      <div className="relative px-4 pb-3.5 pt-4 text-center sm:px-6">
        <span
          aria-hidden
          className={cn(
            "mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-charcoal-700 font-display text-base text-offwhite/85 ring-2 ring-offset-2 ring-offset-charcoal-800",
            pill.ringCls,
          )}
        >
          {initialsOf(name)}
        </span>

        {detail?.clientId ? (
          // The name is also the way through to the client's page, so it has to
          // BE a real touch target: one line of 22px type is 28px tall, and 12px
          // of padding takes the hit box to 52. The WRAPPER owns the spacing and
          // cancels that padding, so the hero looks identical either way — and
          // putting the padding AND a negative margin on the link itself sets
          // margin-top twice, where the winner is Tailwind's output order rather
          // than the order written here.
          <div className="-mb-3 mt-0.5">
            <Link
              href={`/dashboard/clients/${detail.clientId}`}
              className={cn(
                NAME_WRAP_CLS,
                "block py-3 font-display text-[22px] font-normal leading-tight transition-colors duration-150 ease-out hover:text-gold sm:text-[26px]",
              )}
            >
              {name}
            </Link>
          </div>
        ) : (
          <h3
            className={cn(
              NAME_WRAP_CLS,
              "mt-3.5 font-display text-[22px] font-normal leading-tight sm:text-[26px]",
            )}
          >
            {name}
          </h3>
        )}

        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
          <span
            className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", pill.cls)}
          >
            {pill.label}
          </span>
          {/* SOURCE, not status. A synced booking is just as booked as a native
              one; what differs is who owns it. */}
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-medium",
              external ? "bg-sky-400/15 text-sky-300" : "bg-charcoal-700 text-muted",
            )}
          >
            {sourceLabel}
          </span>
          {row.seriesId && (
            <span className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] font-medium text-gold">
              ↻ Weekly
            </span>
          )}
        </div>
      </div>

      {/* The booking's own facts. Label left, value right, wrapping to its own
          line before anything compresses — a 40-character service name pushes
          the price down, it never squeezes it. */}
      <dl className="relative border-t border-subtle px-4 py-2.5 text-sm sm:px-6">
        <Fact icon={<TagIcon />} label="Service">
          <span className="[overflow-wrap:anywhere]">{service ?? "Appointment"}</span>
        </Fact>
        {barber && (
          <Fact icon={<ScissorsIcon />} label={cap(vocab.providerNoun)}>
            <span className="[overflow-wrap:anywhere]">{barber}</span>
          </Fact>
        )}
        <Fact icon={<CalendarIcon />} label="Date">
          <span className="tabular-nums">{dateLabel}</span>
        </Fact>
        <Fact icon={<ClockIcon />} label="Time">
          <span className="tabular-nums">{timeLabel}</span>
          {durMin && <span className="text-muted"> · {durMin} min</span>}
        </Fact>
        <Fact icon={<CashIcon />} label="Price">
          <span className="tabular-nums">
            {price != null ? `$${price.toFixed(2)}` : "Not priced"}
          </span>
          {priceEdit.allowed && !priceEdit.open && (
            <button
              type="button"
              onClick={priceEdit.begin}
              data-qa="price-edit"
              className="ml-2 inline-flex h-11 items-center rounded-md px-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 sm:h-7"
            >
              Edit
            </button>
          )}
        </Fact>
      </dl>
      {priceEdit.open && <PriceEditor state={priceEdit} />}
    </section>
  );
}

/**
 * THE PRICE, CORRECTED FROM THE SHEET. The ticket is a snapshot from booking
 * time and the chair is where it stops being true — an add-on, a regular's
 * discount, or simply more handed over than the number on the screen.
 * Checkout already keeps the barber's final figure, so this covers the two
 * moments checkout cannot: before it (the sheet and the customer's manage page
 * still show the old number) and after it (the money was recorded at the old
 * ticket, and the real figure is known only now — that is the second field,
 * shown only once the booking has been checked out).
 *
 * Offered only where the API would accept it: a native booking that is
 * pending, upcoming or completed. The API is the rule; this is the same
 * predicate so the button never leads to a refusal.
 */
type PriceEditState = {
  allowed: boolean;
  open: boolean;
  amount: string;
  collected: string | null;
  error: string | null;
  pending: boolean;
  begin: () => void;
  cancel: () => void;
  setAmount: (v: string) => void;
  setCollected: (v: string) => void;
  save: () => void;
};

/** Dollars typed by a barber → a number with at most two decimals, or null. */
function parseDollars(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
}

function usePriceEdit({
  row,
  detail,
  toast,
  onSaved,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  toast: Toast;
  onSaved: () => void;
}): PriceEditState {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [collected, setCollected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const allowed =
    detail !== null &&
    detail.source === "appointment" &&
    detail.origin === "chairback" &&
    (detail.status === "pending" ||
      detail.status === "upcoming" ||
      detail.status === "completed");
  const checkedOut = detail?.checkedOutAt != null;

  function begin() {
    const price = detail?.price ?? row.price;
    setAmount(price != null ? price.toFixed(2) : "");
    setCollected(
      checkedOut ? ((detail?.payment.inPersonCents ?? 0) / 100).toFixed(2) : null,
    );
    setError(null);
    setOpen(true);
  }
  function cancel() {
    setOpen(false);
    setError(null);
  }
  function save() {
    const a = parseDollars(amount);
    if (a === null) {
      setError("Enter a price like 45 or 45.50.");
      return;
    }
    let c: number | undefined;
    if (collected !== null) {
      const parsed = parseDollars(collected);
      if (parsed === null) {
        setError("Enter what was collected, like 45 or 45.50.");
        return;
      }
      c = parsed;
    }
    setError(null);
    start(async () => {
      const res = await updateAppointmentPriceAction(row.id, {
        amount: a,
        ...(c !== undefined ? { collected: c } : {}),
      });
      if (!res.ok) {
        setError(
          res.error === "below_online_payment"
            ? "That's below what was already paid online. Refund from the payment instead."
            : res.error === "not_checked_out"
              ? "Check out first to record what was collected."
              : res.error === "external"
                ? "This booking's price lives where it was made."
                : "Couldn't save the price.",
        );
        return;
      }
      toast(
        c !== undefined ? `Price $${a.toFixed(2)} · collected $${c.toFixed(2)}` : `Price $${a.toFixed(2)}`,
        "success",
      );
      setOpen(false);
      onSaved();
    });
  }

  return {
    allowed,
    open,
    amount,
    collected,
    error,
    pending,
    begin,
    cancel,
    setAmount,
    setCollected,
    save,
  };
}

function PriceEditor({ state }: { state: PriceEditState }) {
  // Escape cancels THIS, not the whole sheet: Dialog listens for Escape too,
  // and without stopping it here one keypress would throw the booking away.
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      state.save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.cancel();
    }
  }
  return (
    <div className="relative border-t border-subtle px-4 py-3 sm:px-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Price
          <input
            autoFocus
            inputMode="decimal"
            value={state.amount}
            onChange={(e) => state.setAmount(e.target.value)}
            onKeyDown={onKey}
            aria-label="Price in dollars"
            className={cn(INPUT, "tabular-nums")}
          />
        </label>
        {state.collected !== null && (
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
            Collected at the chair
            <input
              inputMode="decimal"
              value={state.collected}
              onChange={(e) => state.setCollected(e.target.value)}
              onKeyDown={onKey}
              aria-label="Collected at the chair, in dollars"
              className={cn(INPUT, "tabular-nums")}
            />
          </label>
        )}
      </div>
      {state.collected !== null && (
        <p className="mt-1.5 text-[11px] text-muted">
          Already checked out — the collected figure is what counts as revenue.
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-soft">
          {state.error}
        </p>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={state.cancel}
          disabled={state.pending}
          className="h-11 rounded-lg border border-subtle px-3 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite sm:h-9"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={state.save}
          disabled={state.pending}
          data-qa="price-save"
          className="h-11 rounded-lg bg-gold px-3 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold/90 disabled:opacity-60 sm:h-9"
        >
          {state.pending ? "Saving…" : "Save price"}
        </button>
      </div>
    </div>
  );
}

/**
 * One fact: a small brass icon, a muted label, and the value hard against the
 * right. `min-w-0` on the value plus `flex-wrap` means a long value wraps under
 * its own label instead of squashing it — the failure the old edit grid had.
 */
function Fact({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-subtle/50 py-1.5 first:pt-0 last:border-b-0 last:pb-0">
      <dt className="flex flex-none items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        <span className="flex h-4 w-4 items-center justify-center text-gold/70">{icon}</span>
        {label}
      </dt>
      <dd className="ml-auto min-w-0 text-right text-sm leading-snug text-offwhite">
        {children}
      </dd>
    </div>
  );
}

/**
 * THE ACTION ROW. Three equal, compact targets under the hero — the three
 * things a barber does with an open booking. Contact and More each open the
 * same styled action surface; Reschedule goes straight to the editor, or to
 * whoever owns the schedule when it is not ours.
 */
function ActionRow({
  detail,
  busy,
  onContact,
  onReschedule,
  onMore,
}: {
  detail: AppointmentDetail | null;
  busy: boolean;
  onContact: () => void;
  onReschedule: () => void;
  onMore: () => void;
}) {
  const hasContact = Boolean(detail && (detail.contact.phone || detail.contact.email));
  const external = detail?.origin === "external";
  const manageUrl = detail?.externalManageUrl ?? null;

  return (
    <div className="grid grid-cols-3 gap-2" data-qa="sheet-actions">
      <ActionButton
        icon={<PhoneIcon />}
        label="Contact"
        onClick={onContact}
        disabled={!detail || !hasContact}
        title={
          detail && !hasContact ? "No phone or email on file for this booking" : undefined
        }
      />
      {external && manageUrl ? (
        <ActionButton
          icon={<ExternalIcon />}
          label="Reschedule"
          href={manageUrl}
          title={`Opens ${detail?.originLabel ?? "the other system"}, which owns this booking`}
        />
      ) : (
        <ActionButton
          icon={<CalendarIcon />}
          label="Reschedule"
          onClick={onReschedule}
          disabled={!detail?.editable || busy}
          title={
            detail && !detail.editable
              ? detail.readOnlyReason === "external"
                ? `Booked in ${detail.originLabel} — change it there`
                : "This booking is closed and can no longer be moved"
              : undefined
          }
        />
      )}
      <ActionButton
        icon={<DotsIcon />}
        label="More"
        onClick={onMore}
        disabled={!detail || busy}
      />
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  href,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  title?: string;
}) {
  const cls =
    "flex min-h-[3.25rem] min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-subtle bg-charcoal-800/40 px-1.5 py-2 text-[11px] font-medium leading-tight text-offwhite/85 transition-colors duration-150 ease-out hover:border-gold/40 hover:text-gold disabled:pointer-events-none disabled:opacity-40";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className={cls}
      >
        <span className="text-gold/80">{icon}</span>
        <span className="[overflow-wrap:anywhere] text-center">{label}</span>
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={cls}>
      <span className={cn(disabled ? "text-muted" : "text-gold/80")}>{icon}</span>
      <span className="[overflow-wrap:anywhere] text-center">{label}</span>
    </button>
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
  const vocab = useVocab();
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
          <p className="mt-0.5 text-[11px] text-muted">still to collect</p>
        )}
      </div>

      {external ? (
        <p className="mt-3 border-t border-subtle pt-3 text-xs leading-relaxed text-muted">
          No ChairBack payment recorded. {detail.originLabel} took this booking, so
          whether a deposit or the full ticket was paid is only visible there.
        </p>
      ) : (
        <dl className="mt-3 flex flex-col gap-1.5 border-t border-subtle pt-3 text-xs">
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
                p.method ? `At the ${vocab.stationNoun} · ${METHOD_LABEL[p.method] ?? p.method}` : `At the ${vocab.stationNoun}`
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
              label={
                p.cardOnFile?.status === "saved"
                  ? "Card on file (kept, not charged)"
                  : p.cardOnFile?.status === "charged"
                    ? "Card on file · fee charged"
                    : p.cardOnFile?.status === "failed"
                      ? "Card on file · charge declined - collect at the next visit"
                      : p.cardOnFile?.status === "released"
                        ? "Card on file · released"
                        : "Card"
              }
              value={`${p.card.brand} ···· ${p.card.last4}`}
              tone={p.cardOnFile?.status === "failed" ? "bad" : undefined}
            />
          )}
        </dl>
      )}

      {(canCheckout || p.receiptUrl) && (
        <div className="mt-3.5 flex flex-col gap-2 border-t border-subtle pt-3.5">
          {/* The sheet's ONE solid-brass action, next to the number it acts on. */}
          {canCheckout && (
            <button
              type="button"
              onClick={onCheckout}
              data-qa="start-checkout"
              className="flex h-11 w-full items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              {p.collectedCents > 0 ? "Collect the rest" : "Start checkout"}
            </button>
          )}
          {p.receiptUrl && (
            <a
              href={p.receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-11 w-full items-center justify-center rounded-xl border border-subtle px-5 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              View receipt
            </a>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * THE CLIENT, as ChairBack knows them: whether this shop may text them, and
 * which clock the times above are on.
 *
 * 🔴 The messaging line is the TCPA gate said out loud. A client synced from
 * Acuity has a phone and no consent, which looks identical to a textable
 * client from the outside — so the sheet states it rather than leaving the
 * barber to find out when a nudge silently never sends.
 */
function ClientCard({
  detail,
  loadError,
  zoneDiffers,
  browserZone,
}: {
  detail: AppointmentDetail | null;
  loadError: boolean;
  zoneDiffers: boolean;
  browserZone: string | null;
}) {
  if (loadError) return null;
  if (!detail) return <CardSkeleton title="Client" rows={2} />;

  const sms = SMS_COPY[detail.sms.state];
  const consent =
    detail.sms.state === "ok" && detail.sms.consentAt
      ? `Consented ${fmtDay(detail.sms.consentAt, detail.timezone)}`
      : null;

  return (
    <Panel title="Client">
      <dl className="flex flex-col gap-2.5 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <dt className="flex flex-none items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            <span className={cn("flex h-4 w-4 items-center justify-center", sms.tone)}>
              {sms.ok ? <CheckIcon /> : <BanIcon />}
            </span>
            Messaging
          </dt>
          <dd className="ml-auto min-w-0 text-right">
            <span className={cn("text-sm leading-snug", sms.tone)}>{sms.label}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-muted">
              {consent ?? sms.detail}
            </span>
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-subtle/50 pt-2.5">
          <dt className="flex flex-none items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            <span className="flex h-4 w-4 items-center justify-center text-gold/70">
              <GlobeIcon />
            </span>
            Timezone
          </dt>
          <dd className="ml-auto min-w-0 text-right">
            <span className="[overflow-wrap:anywhere] text-sm leading-snug text-offwhite">
              {detail.timezone.replace(/_/g, " ")}
            </span>
            {/* Only worth a second line when it would change what the barber
                just read: on the same clock, saying so is noise. */}
            {zoneDiffers && browserZone && (
              <span className="mt-0.5 block text-[11px] leading-snug text-amber-300/90">
                Your device is on {browserZone.replace(/_/g, " ")}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

/**
 * What ChairBack can say about texting this client. Every "no" names the fix,
 * or names why there isn't one — a STOP can only be undone by the client.
 */
const SMS_COPY: Record<
  AppointmentDetail["sms"]["state"],
  { label: string; detail: string; tone: string; ok: boolean }
> = {
  ok: {
    label: "Can text",
    detail: "Reminders and nudges will send",
    tone: "text-emerald-soft",
    ok: true,
  },
  no_consent: {
    label: "No SMS consent",
    detail: "Ask them to opt in — texts won't send until they do",
    tone: "text-amber-300",
    ok: false,
  },
  opted_out: {
    label: "Opted out",
    detail: "They texted STOP. Only they can undo it, with START",
    tone: "text-danger-soft",
    ok: false,
  },
  no_phone: {
    label: "No number on file",
    detail: "Add one from Edit appointment",
    tone: "text-muted",
    ok: false,
  },
  no_client: {
    label: "No client record",
    detail: "A walk-in with no profile to text",
    tone: "text-muted",
    ok: false,
  },
};

/**
 * THE REST OF THEIR BOOK — three back, three forward. A barber deciding
 * anything about a booking is usually asking "have they no-showed before?" or
 * "are they already coming back Thursday?", and both used to mean leaving the
 * sheet for the client page.
 */
function HistoryCard({ detail }: { detail: AppointmentDetail | null }) {
  if (!detail) return null;
  const { previous, upcoming } = detail.history;
  if (previous.length === 0 && upcoming.length === 0) {
    return (
      <Panel title="Their other visits">
        <p className="text-xs leading-relaxed text-muted">
          {detail.clientId
            ? "Nothing else on the books — this is the only appointment for them."
            : "A walk-in with no client record, so there is no history to show."}
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Their other visits">
      {upcoming.length > 0 && (
        <HistoryGroup label="Upcoming" items={upcoming} timezone={detail.timezone} />
      )}
      {previous.length > 0 && (
        <HistoryGroup
          label="Previous"
          items={previous}
          timezone={detail.timezone}
          className={upcoming.length > 0 ? "mt-3 border-t border-subtle pt-3" : undefined}
        />
      )}
    </Panel>
  );
}

function HistoryGroup({
  label,
  items,
  timezone,
  className,
}: {
  label: string;
  items: DetailHistoryItem[];
  timezone: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {items.map((it) => {
          const pill = appointmentStatusPill({
            status: (it.status as AppointmentCardStatus) ?? "upcoming",
          });
          return (
            <li
              key={`${it.source}-${it.id}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
            >
              <span className="flex-none tabular-nums text-offwhite/85">
                {fmtDay(it.startsAt, timezone)}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-muted">
                {it.serviceName ?? "Appointment"}
              </span>
              <span
                className={cn(
                  "flex-none rounded-full px-2 py-0.5 text-[10px] font-medium",
                  pill.cls,
                )}
              >
                {pill.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

//  ── the action surfaces ───────────────────────────────────────────────────

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** Why it cannot run. Rendered under the label — never a browser alert. */
  reason?: string;
  tone?: "danger";
  /** A rule above this item, to set a destructive action apart from the rest. */
  divided?: boolean;
}

/**
 * ONE ACTION SURFACE, two placements: a bottom sheet on a phone, the same card
 * centered once the dialog floats.
 *
 * 🔴 IT IS `fixed` INSIDE THE DIALOG PANEL, AND THAT IS DELIBERATE. The panel
 * carries `.glass` → `backdrop-filter`, which makes it the containing block for
 * fixed descendants. So `fixed inset-0` here means "fill the panel", which is
 * exactly what a sheet over a sheet should do — and it keeps the menu INSIDE
 * Dialog's focus trap, which a portal to document.body would break (Tab would
 * be yanked back into the panel on the first press).
 *
 * Closing: Escape and the dialog backdrop are intercepted by the sheet (see
 * closeTopmost), the scrim below closes on click, activating an item closes,
 * and moving focus out of the menu closes it — standard popover behavior, and
 * the reason tabbing behind an open menu is not a trap.
 */
function ActionMenu({
  title,
  items,
  onClose,
}: {
  title: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the first thing that can actually be used, so a keyboard lands
  // inside the menu rather than wherever the trigger left it.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    first?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-10 flex items-end justify-center sm:items-center sm:p-6"
      data-qa="action-menu"
    >
      <button
        type="button"
        aria-label="Dismiss"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />
      <div
        ref={ref}
        role="menu"
        aria-label={title}
        onBlur={(e) => {
          // Only when focus left the menu entirely — moving between items
          // fires blur too, with relatedTarget still inside.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
        }}
        className="relative w-full max-w-md rounded-t-2xl border border-subtle bg-charcoal-900 p-2 shadow-ambient-lg sm:max-w-xs sm:rounded-2xl"
        style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <p className="px-3 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
          {title}
        </p>
        <ul className="flex flex-col">
          {items.map((it) => (
            <li
              key={it.key}
              className={it.divided ? "mt-1 border-t border-subtle pt-1" : undefined}
            >
              <MenuRow item={it} onDone={onClose} />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 flex h-11 w-full items-center justify-center rounded-xl border border-subtle-strong text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const cls = cn(
    // 44px floor, and the label wraps rather than clipping at 320px.
    "flex min-h-[2.75rem] w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150 ease-out",
    item.disabled
      ? "cursor-not-allowed text-muted"
      : item.tone === "danger"
        ? "text-danger-soft hover:bg-danger-soft/10"
        : "text-offwhite hover:bg-charcoal-700",
  );
  const body = (
    <>
      <span
        className={cn(
          "flex h-5 w-5 flex-none items-center justify-center",
          item.disabled ? "text-muted/70" : item.tone === "danger" ? "" : "text-gold/80",
        )}
      >
        {item.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block [overflow-wrap:anywhere] leading-snug">{item.label}</span>
        {item.reason && (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">
            {item.reason}
          </span>
        )}
      </span>
      {item.external && <span className="flex-none text-muted"><ExternalIcon /></span>}
    </>
  );

  if (item.disabled) {
    return (
      <span role="menuitem" aria-disabled className={cls}>
        {body}
      </span>
    );
  }
  if (item.href) {
    return (
      <a
        role="menuitem"
        href={item.href}
        {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={onDone}
        className={cls}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      role="menuitem"
      type="button"
      onClick={() => {
        item.onClick?.();
        onDone();
      }}
      className={cls}
    >
      {body}
    </button>
  );
}

/**
 * REACHING THE CLIENT. Every entry is a device handoff — `tel:`, `sms:`,
 * `mailto:` or the clipboard — so a channel with nothing behind it is not
 * rendered at all.
 *
 * 🔴 TEXT IS THE ONE EXCEPTION and it stays VISIBLE while disabled: a number
 * we may not text looks identical to one we may, and silently hiding Text
 * would leave the barber wondering. It says which of the two "no"s it is,
 * because only one of them is theirs to fix.
 *
 * 🔴 A copy toast never names the value. "Phone number copied" is the whole
 * message on purpose — a contact detail must not ride in a toast, a log line
 * or an analytics event.
 */
function ContactMenu({
  detail,
  toast,
  onClose,
}: {
  detail: AppointmentDetail;
  toast: Toast;
  onClose: () => void;
}) {
  const { phone, phoneDisplay, email } = detail.contact;
  const canText = detail.sms.state === "ok";

  const copy = useCallback(
    async (kind: "phone" | "email", value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast(kind === "phone" ? "Phone number copied" : "Email copied", "success");
      } catch {
        toast("Couldn't copy — press and hold to select it instead", "error");
      }
    },
    [toast],
  );

  const items: MenuItem[] = [];
  if (phone) {
    items.push({
      key: "call",
      label: "Call",
      icon: <PhoneIcon />,
      href: `tel:${phone}`,
    });
    items.push({
      key: "text",
      label: "Text",
      icon: <ChatIcon />,
      // A phone CALL needs no consent; an SMS does. Same number, two rules.
      ...(canText
        ? { href: `sms:${phone}` }
        : { disabled: true, reason: SMS_COPY[detail.sms.state].detail }),
    });
  }
  if (email) {
    items.push({
      key: "email",
      label: "Email",
      icon: <MailIcon />,
      href: `mailto:${email}`,
    });
  }
  if (phone) {
    items.push({
      key: "copy-phone",
      label: "Copy phone number",
      icon: <CopyIcon />,
      onClick: () => void copy("phone", phoneDisplay ?? phone),
    });
  }
  if (email) {
    items.push({
      key: "copy-email",
      label: "Copy email",
      icon: <CopyIcon />,
      onClick: () => void copy("email", email),
    });
  }

  return <ActionMenu title="Reach your client" items={items} onClose={onClose} />;
}

/**
 * EVERYTHING ELSE. Each entry calls exactly the endpoint the appointment card
 * already calls — the sheet is a second door onto the same actions, never a
 * second set of rules.
 */
function MoreMenu({
  row,
  detail,
  onClose,
  onEdit,
  onAct,
}: {
  row: AgendaRow;
  detail: AppointmentDetail;
  onClose: () => void;
  onEdit: () => void;
  onAct: (
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
    closeAfter?: boolean,
  ) => void;
}) {
  const items: MenuItem[] = [];
  const native = detail.source === "appointment" && detail.origin === "chairback";
  const live = detail.status === "upcoming" || detail.status === "pending";

  if (detail.clientId) {
    items.push({
      key: "client",
      label: "View client",
      icon: <UserIcon />,
      href: `/dashboard/clients/${detail.clientId}`,
    });
  }
  if (detail.editable) {
    items.push({ key: "edit", label: "Edit appointment", icon: <PencilIcon />, onClick: onEdit });
  }
  if (native && detail.status === "upcoming" && detail.checkInStatus !== "arrived") {
    items.push({
      key: "arrived",
      label: "Mark arrived",
      icon: <CheckIcon />,
      onClick: () => onAct(markArrivedAction, "Marked arrived"),
    });
  }
  if (native && live) {
    items.push({
      key: "done",
      label: "Mark done",
      icon: <CheckIcon />,
      onClick: () => onAct(completeAppointmentAction, "Marked done"),
    });
    items.push({
      key: "no-show",
      label: "Mark no-show",
      icon: <EmptyChairIcon />,
      onClick: () => onAct(noShowAppointmentAction, "Marked no-show"),
    });
    // Cancelling closes the sheet: the booking it was describing is gone, and
    // leaving it open on a cancelled row invites a second, confusing action.
    // A recurring series keeps its scope menu on the CARD — this cancels the
    // one occurrence, which is the only scope a single booking can speak for.
    items.push({
      key: "cancel",
      divided: true,
      label: row.seriesId ? "Cancel this occurrence" : "Cancel appointment",
      icon: <BanIcon />,
      tone: "danger",
      onClick: () => onAct(cancelAppointmentAction, "Canceled", true),
    });
  }
  if (detail.externalManageUrl) {
    items.push({
      key: "manage",
      label: `Edit in ${detail.originLabel}`,
      icon: <ExternalIcon />,
      href: detail.externalManageUrl,
      external: true,
    });
  }
  if (items.length === 0) {
    items.push({
      key: "none",
      label: "Nothing else to do here",
      icon: <BanIcon />,
      disabled: true,
      reason: "This booking is closed.",
    });
  }

  return <ActionMenu title="More" items={items} onClose={onClose} />;
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
  const vocab = useVocab();
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
            className="w-40 min-w-0 bg-transparent text-center font-display text-5xl tabular-nums text-offwhite outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
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
        Records the sale and marks the {vocab.serviceNoun} done. ChairBack never touches the money —
        you keep 100%.
      </p>
    </div>
  );
}

//  ── footers ───────────────────────────────────────────────────────────────

/**
 * The detail view's footer is deliberately QUIET: the sheet's one solid-brass
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
        data-qa="edit-appointment"
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
 * A quiet secondary and ONE solid-brass primary.
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

/** Short form for history lines: "Aug 4". */
function fmtDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
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
  <Svg size={16}>
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
const PencilIcon = () => (
  <Svg size={14}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);
const UserIcon = () => (
  <Svg size={18}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Svg>
);
const BanIcon = () => (
  <Svg size={16}>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.6 5.6 12.8 12.8" />
  </Svg>
);
/** An empty chair: the no-show, said as a picture rather than a second ban. */
const EmptyChairIcon = () => (
  <Svg size={16}>
    <path d="M7 4v7h10V4M5 11h14M8 11v9M16 11v9" />
  </Svg>
);
const DotsIcon = () => (
  <Svg size={18}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);
const ExternalIcon = () => (
  <Svg size={16}>
    <path d="M14 4h6v6M20 4l-8 8" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Svg>
);
const ArrowLeftIcon = () => (
  <Svg size={18}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);
