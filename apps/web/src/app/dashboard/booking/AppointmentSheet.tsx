"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import {
  appointmentEnded,
  CARD_FEE_APPROVAL_DAYS,
  CANCEL_PAST_END_COPY,
  describeLateCancelCardOutcome,
  describeLateCancelChargeResult,
  describeNoShowCardOutcome,
  describeNoShowChargeResult,
  lateCancelAsksFirst,
  type LateCancelCardOutcome,
  type NoShowCardOutcome,
  type NoShowChargeResult,
} from "@chairback/config/shopPolicy";
import {
  RECORDED_TIP_MAX_CENTS,
  RECORDED_TIP_METHOD_LABEL,
  formatTipCents,
  recordedTipAllowed,
  tipDollarsToCents,
  type RecordedTipMethod,
} from "@chairback/config/tips";
import { copyText, mailtoUri, smsUri, telUri } from "@/lib/contactUri";
import { parsePrice } from "@/lib/serviceFields";
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
  type SavedNotice,
} from "./AppointmentEditForm";
import { CheckoutFlow } from "./CheckoutFlow";
import { SeriesEditFields, SeriesEditFooter, useSeriesEdit } from "./SeriesEditView";
import { CheckoutRefund } from "./CheckoutRefund";
import { DepositRefund } from "./DepositRefund";
import { TipRefund } from "./TipRefund";
import {
  cancelAppointmentAction,
  checkoutAppointmentAction,
  completeAppointmentAction,
  correctCompletedVisitAction,
  updateAppointmentPriceAction,
  getAppointmentDetailAction,
  markArrivedAction,
  noShowAppointmentAction,
  lateCancelAppointmentAction,
  decideCardFeeAction,
  recordTipAction,
  undoNoShowAction,
  removeWalkInAction,
  type AppointmentDetail,
  type DetailHistoryItem,
} from "./actions";
import type { AgendaRow } from "./page";
import { requestRebook } from "./rebookEvent";
import { InstagramHandle } from "@/components/InstagramHandle";
import { SpecialChip } from "../_components/SpecialChip";

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
 *   series  → a repeat's time, service or provider, this visit and every
 *             upcoming one after it (SeriesEditView.tsx)
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
 * about WHICH number, deliberately. The handoff is the barber's own Messages,
 * Phone or Mail app, so MISSING consent does not decide whether Text is live —
 * having a number does. An explicit OPT-OUT is the one exception, and it is
 * respected here as everywhere. See ContactMenu.
 */

export type SheetView = "detail" | "edit" | "series" | "charges" | "pay";

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
  canBookAgain = false,
}: {
  row: AgendaRow;
  toast: Toast;
  onClose: () => void;
  /** The agenda needs re-reading: a save, a checkout, anything that mutates. */
  onChanged: () => void;
  initialView?: SheetView;
  /**
   * Offer "Book again". Only where the calendar's booking form is mounted to
   * answer it (a native-booking shop) - anywhere else it would be a button
   * that does nothing.
   */
  canBookAgain?: boolean;
}) {
  const vocab = useVocab();
  const [rawView, setView] = useState<SheetView>(initialView);
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

  // What the last edit's save said, shown in the footer of the booking it
  // returns to. Stays until the next edit starts or the sheet closes - a
  // confirmation that fades while the barber is looking elsewhere is one he
  // never saw.
  const [savedNotice, setSavedNotice] = useState<SavedNotice | null>(null);
  useEffect(() => {
    if (rawView === "edit") setSavedNotice(null);
  }, [rawView]);

  const edit = useAppointmentEdit({
    row,
    detail,
    onSaved: (notice) => {
      setSavedNotice(notice);
      setView("detail");
      onChanged();
      load();
    },
  });
  const series = useSeriesEdit({
    row,
    active: rawView === "series",
    onApplied: () => {
      onChanged();
      load();
    },
  });
  // 🔴 Every visit to Edit starts from the booking as it is NOW. Cancel and Back
  // only change the view, so without this the abandoned change came back (and
  // was saved with the next edit), and a price saved from the hero was written
  // back to its old figure.
  useEffect(() => {
    if (rawView === "edit") edit.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawView]);

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

  // The booking's own record wins once it has loaded. The agenda row can be a
  // step behind it: a save that moves the booking out of the calendar's loaded
  // weeks leaves this sheet holding the last row the calendar had, while
  // `load()` re-reads the booking itself after every change.
  const own = detail?.source === "appointment" ? detail : null;
  const startIso = own?.startsAt ?? row.start;
  const endIso = own ? (own.endsAt ?? row.end) : row.end;
  const dateLabel = useMemo(() => fmtDate(startIso, zone), [startIso, zone]);
  const timeLabel = useMemo(
    () => fmtTimeRange(startIso, endIso, zone),
    [startIso, endIso, zone],
  );
  const durMin =
    endIso && endIso > startIso
      ? Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000)
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

  /**
   * 🔴 TWO CHECKOUT SCREENS, AND THE FLAG PICKS ONE.
   *
   * `serviceCheckoutEnabled` is the platform kill switch, read from the server
   * with the booking. ON, the sheet opens CheckoutFlow, which re-reads the
   * amount and the available methods from the API every time - the agenda
   * row's price is a cache, and charging against a cache is how a barber
   * confirms one figure while another is taken. OFF, the sheet keeps the
   * ORIGINAL charges -> pay screens below, unchanged, so turning the feature
   * off removes the new flow without removing checkout from the product.
   */
  const newCheckout = detail?.serviceCheckoutEnabled ?? false;
  /**
   * The calendar card opens `charges`, which in the ORIGINAL flow is the
   * itemised step before paying. The new flow's own review screen replaces it,
   * so with the flag on the two collapse into one rather than asking the barber
   * to press Next through a screen that now says the same thing twice.
   */
  const view = newCheckout && rawView === "charges" ? "pay" : rawView;

  //  ── the ORIGINAL chair checkout, used while the flag is off ──
  const [amount, setAmount] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]["key"] | null>(null);
  // 🔴 CHECK THE AMOUNT THE FIELD SHOWS. `amount` stays null until the barber
  // edits it, and until then the field shows the balance due. Parsing the raw
  // state instead read that untouched "50.00" as blank: "Enter an amount"
  // under a $50.00, and Mark paid disabled until the barber retyped it.
  // No known balance (an unpriced service) shows blank, never a $0.00 that
  // one tap would record.
  const amountValue = amount ?? (owedCents === null ? "" : (owedCents / 100).toFixed(2));
  const typed = parsePrice(amountValue);
  // Blank is "not set" to a price field but no amount at checkout; the API
  // caps at 100,000.
  const parsedAmount =
    typed.ok && typed.value !== null && typed.value <= 100_000 ? typed.value : null;
  const amountValid = parsedAmount !== null;

  // 🔴 A REFUSED SAVE IS READ IN THE FOOTER, not in a toast. A toast draws
  // beneath the dialog, so on a phone "Couldn't save the checkout" was
  // invisible and Mark paid just looked dead (Drick, 2026-09-29). Cleared the
  // moment the barber changes the amount or the method, or tries again.
  const [payError, setPayError] = useState<string | null>(null);
  // 🔴 "SAVING…" IS ITS OWN STATE. `useTransition`'s pending flag does not stay
  // on while an async callback awaits (React 18), so during a slow save the
  // button read "Mark paid" and could be tapped again: nothing seemed to be
  // happening. This is true from the tap until the answer is in, and it
  // disables the button, so a second tap can't send a second payment.
  const [saving, setSaving] = useState(false);

  function submitCheckout() {
    if (saving || !method || parsedAmount === null) return;
    const amountToSave = parsedAmount;
    setPayError(null);
    setSaving(true);
    void (async () => {
      try {
        let res: Awaited<ReturnType<typeof checkoutAppointmentAction>>;
        try {
          res = await checkoutAppointmentAction(row.id, { amount: amountToSave, method });
        } catch {
          // No answer (no signal, the app backgrounded). The API records the
          // payment and the completion together or not at all, so nothing is
          // half-saved: the screen stays as it was, and Mark paid tries again.
          setPayError(checkoutFailureCopy("network_error"));
          return;
        }
        if (!res.ok) {
          if (res.error === "paid_already") {
            // Already recorded - by another device, or by an attempt whose
            // answer never arrived. Show the calendar what is true, not a retry.
            toast(`This ${vocab.serviceNoun} was already checked out`, "error");
            onChanged();
            onClose();
            return;
          }
          setPayError(checkoutFailureCopy(res.error));
          return;
        }
        toast(`Paid $${amountToSave.toFixed(2)} · ${row.clientName}`, "success");
        onChanged();
        onClose();
      } finally {
        setSaving(false);
      }
    })();
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
    setSavedNotice(null);
    start(async () => {
      let res: { ok: boolean };
      try {
        res = await fn(row.id);
      } catch {
        res = { ok: false };
      }
      if (!res.ok) {
        // In the footer, not a toast: a toast draws beneath this sheet, so on a
        // phone a failed Mark done or Cancel looked like nothing happened.
        setSavedNotice({
          message: "That didn't go through. Nothing changed, so try again.",
          tone: "warning",
        });
        load(); // another device may already have changed it
        return;
      }
      toast(label, "success");
      onChanged();
      if (closeAfter) onClose();
      else load();
    });
  }

  //  ── Remove walk-in: asked in the sheet, answered in the sheet ──
  // The question sits in the footer, which never scrolls away, and so does a
  // refusal: a toast draws beneath this dialog and is invisible on a phone.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Its own busy flag, not useTransition: that one does not stay on across an
  // awaited call, and a second tap would send a second request.
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (rawView !== "detail") setConfirmRemove(false);
  }, [rawView]);

  function askRemoveWalkIn() {
    setMenu(null);
    setSavedNotice(null);
    setRemoveError(null);
    setConfirmCorrect(null);
    setConfirmRemove(true);
  }

  function removeWalkIn() {
    if (removing) return;
    setRemoveError(null);
    setRemoving(true);
    void (async () => {
      try {
        let res: Awaited<ReturnType<typeof removeWalkInAction>>;
        try {
          res = await removeWalkInAction(row.id);
        } catch {
          res = { ok: false };
        }
        if (!res.ok) {
          setRemoveError(res.message ?? "That didn't go through. Nothing changed, so try again.");
          load();
          return;
        }
        toast("Walk-in removed", "success");
        onChanged();
        onClose();
      } finally {
        setRemoving(false);
      }
    })();
  }

  //  ── A completed visit that never happened: no-show / cancel after the fact ──
  // The 15-minute sweep completes every booking whose time has passed, so a
  // no-show not marked in time reads as a finished visit. Same shape as Remove
  // walk-in above: asked in the footer, refused in the footer, one request.
  const [confirmCorrect, setConfirmCorrect] = useState<"no_show" | "canceled" | null>(null);
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    if (rawView !== "detail") setConfirmCorrect(null);
  }, [rawView]);

  function askCorrect(outcome: "no_show" | "canceled") {
    setMenu(null);
    setSavedNotice(null);
    setCorrectError(null);
    setConfirmRemove(false);
    setConfirmCorrect(outcome);
  }

  function correctVisit() {
    if (correcting || !confirmCorrect) return;
    const outcome = confirmCorrect;
    setCorrectError(null);
    setCorrecting(true);
    void (async () => {
      try {
        let res: Awaited<ReturnType<typeof correctCompletedVisitAction>>;
        try {
          res = await correctCompletedVisitAction(row.id, outcome);
        } catch {
          res = { ok: false };
        }
        if (!res.ok) {
          setCorrectError(res.message ?? "That didn't go through. Nothing changed, so try again.");
          load();
          return;
        }
        toast(outcome === "no_show" ? "Marked no-show" : "Canceled", "success");
        onChanged();
        onClose();
      } finally {
        setCorrecting(false);
      }
    })();
  }

  //  ── Cancel, once the appointment has ENDED ──
  // The completion sweep now waits a day after the end (NO_SHOW_WINDOW_MS) so
  // a no-show can still be marked - which also leaves Cancel on a booking that
  // already happened, or didn't. A barber cancel refunds any deposit and
  // emails the client: not what a no-show should do. So past the end, Cancel
  // asks first, in the footer, and offers Mark no-show beside it. The server
  // stays permissive: a mistaken booking can still be cancelled.
  const [cancelPastAsk, setCancelPastAsk] = useState(false);
  useEffect(() => {
    if (rawView !== "detail") setCancelPastAsk(false);
  }, [rawView]);

  function cancelOrAsk() {
    setMenu(null);
    setSavedNotice(null);
    if (appointmentEnded(detail?.endsAt ?? row.end)) {
      setNoShowAsk(null);
      setNoShowError(null);
      setConfirmRemove(false);
      setConfirmCorrect(null);
      setCancelPastAsk(true);
      return;
    }
    // Card fees on for this booking: a fee due asks WHO cancelled; no fee
    // possible says why first. With fees off, Cancel stays one tap.
    if (lateCancelAsksFirst(detail?.lateCancelCard)) {
      openLateCancelAsk();
      return;
    }
    act(cancelAppointmentAction, "Canceled", true);
  }

  // The same ask, from Cancel in the menu or from "Charge late-cancel fee" on
  // the Payment card - where a barber coming from Acuity looks for a charge.
  function openLateCancelAsk() {
    setMenu(null);
    setSavedNotice(null);
    setNoShowAsk(null);
    setConfirmRemove(false);
    setConfirmCorrect(null);
    setMarkedCard(null);
    setLateCancelError(null);
    setLateCancelAsk(true);
  }

  //  ── Cancel, when the CLIENT cancelled late ──
  // Drick, 2026-10-30: "I need the charging cancellation fee... asking clients
  // to Zelle you for canceling is ass." A client who cancels by text never
  // touches their link, so the barber records it: the fee on this booking's
  // own terms goes on the kept card, and the footer says what the card did.
  const [lateCancelAsk, setLateCancelAsk] = useState(false);
  const [lateCancelError, setLateCancelError] = useState<string | null>(null);
  const [lateCancelBusy, setLateCancelBusy] = useState(false);
  // A ref as well: a double tap lands before the state above re-renders.
  const lateCancelBusyRef = useRef(false);
  useEffect(() => {
    if (rawView !== "detail") setLateCancelAsk(false);
  }, [rawView]);

  function confirmLateCancel() {
    if (lateCancelBusyRef.current) return;
    lateCancelBusyRef.current = true;
    setLateCancelBusy(true);
    setLateCancelError(null);
    const promised = detail?.lateCancelCard;
    void (async () => {
      try {
        let res: Awaited<ReturnType<typeof lateCancelAppointmentAction>>;
        try {
          res = await lateCancelAppointmentAction(row.id);
        } catch {
          res = { ok: false };
        }
        if (!res.ok) {
          setLateCancelError(res.message ?? "That didn't go through. Nothing changed, so try again.");
          load();
          return;
        }
        setLateCancelAsk(false);
        onChanged();
        if (res.card) {
          setMarkedCard({
            kind: "late_cancel",
            result: res.card,
            last4: promised?.charge ? promised.last4 : null,
          });
          load();
        } else {
          toast("Canceled", "success");
          onClose();
        }
      } finally {
        lateCancelBusyRef.current = false;
        setLateCancelBusy(false);
      }
    })();
  }

  //  ── A client's late-cancel fee waiting for the barber ──
  // Shop.cardFeeNeedsApproval: nothing was charged when the client cancelled.
  // Charge takes the figure fixed at the cancel; Waive lets the card go. ONE
  // request at a time (a ref, not `pending` - a double tap must not send two).
  const [feeDecisionBusy, setFeeDecisionBusy] = useState(false);
  const feeDecisionBusyRef = useRef(false);
  const [feeDecisionError, setFeeDecisionError] = useState<string | null>(null);
  function decideWaitingFee(decision: "charge" | "waive") {
    if (feeDecisionBusyRef.current) return;
    feeDecisionBusyRef.current = true;
    setFeeDecisionBusy(true);
    setFeeDecisionError(null);
    const waiting = detail?.cardFeeAwaiting ?? null;
    void (async () => {
      try {
        let res: Awaited<ReturnType<typeof decideCardFeeAction>>;
        try {
          res = await decideCardFeeAction(row.id, decision);
        } catch {
          res = { ok: false };
        }
        if (!res.ok) {
          setFeeDecisionError(
            res.error === "lapsed"
              ? `More than ${CARD_FEE_APPROVAL_DAYS} days went by, so the card was let go. Nothing was charged.`
              : res.error === "nothing_waiting"
                ? "This fee was already charged or waived."
                : "That didn't go through. Nothing changed, so try again.",
          );
          load();
          return;
        }
        onChanged();
        if (decision === "charge" && res.card) {
          setMarkedCard({ kind: "approved_fee", result: res.card, last4: waiting?.last4 ?? null });
        }
        load();
      } finally {
        feeDecisionBusyRef.current = false;
        setFeeDecisionBusy(false);
      }
    })();
  }

  //  ── No-show: marked, and taken back ──
  // Both ask first, in the footer (a toast draws beneath this dialog and is
  // invisible on a phone), send ONE request (their own busy flag - a
  // transition does not stay on across an awaited call), and answer in the
  // footer. An undo that leaves something as it is - a fee already charged, a
  // refunded deposit - says so there, and waits for Done.
  const [noShowAsk, setNoShowAsk] = useState<"mark" | "undo" | null>(null);
  const [noShowError, setNoShowError] = useState<string | null>(null);
  const [noShowBusy, setNoShowBusy] = useState(false);
  // A ref as well: a double tap lands before the state above re-renders.
  const noShowBusyRef = useRef(false);
  const [undoneNotes, setUndoneNotes] = useState<string[] | null>(null);
  // What the kept card did once the no-show was marked, said in the footer
  // (a toast draws beneath this sheet on a phone). Drick, 2026-10-22: the
  // screen said "Marked no-show" whether the card was charged or not.
  const [markedCard, setMarkedCard] = useState<{
    result: NoShowChargeResult;
    last4: string | null;
    /**
     * Which close this was: a no-show, the client's late cancel, or a fee
     * that waited for the barber's approval and was just charged.
     */
    kind: "no_show" | "late_cancel" | "approved_fee";
  } | null>(null);
  useEffect(() => {
    if (rawView !== "detail") {
      setNoShowAsk(null);
      setUndoneNotes(null);
      setMarkedCard(null);
    }
  }, [rawView]);

  function askNoShow(kind: "mark" | "undo") {
    setMenu(null);
    setSavedNotice(null);
    setNoShowError(null);
    setConfirmRemove(false);
    setConfirmCorrect(null);
    setUndoneNotes(null);
    setMarkedCard(null);
    setNoShowAsk(kind);
  }

  function confirmNoShowChange(override?: "mark") {
    if (noShowBusyRef.current || noShowBusy) return;
    const kind = override ?? noShowAsk;
    if (!kind) return;
    noShowBusyRef.current = true;
    setNoShowError(null);
    setNoShowBusy(true);
    void (async () => {
      try {
        if (kind === "mark") {
          let res: Awaited<ReturnType<typeof noShowAppointmentAction>>;
          try {
            res = await noShowAppointmentAction(row.id);
          } catch {
            res = { ok: false };
          }
          if (!res.ok) {
            setNoShowError(res.message ?? "That didn't go through. Nothing changed, so try again.");
            load();
            return;
          }
          setNoShowAsk(null);
          if (res.card) {
            // The card line before Confirm named its last four; keep them.
            const promised = detail?.noShowCard;
            setMarkedCard({
              kind: "no_show",
              result: res.card,
              last4: detail?.noShowFee?.last4 ?? (promised?.charge ? promised.last4 : null),
            });
          } else {
            toast("Marked no-show", "success");
          }
          onChanged();
          load();
          return;
        }
        let res: Awaited<ReturnType<typeof undoNoShowAction>>;
        try {
          res = await undoNoShowAction(row.id);
        } catch {
          res = { ok: false };
        }
        if (!res.ok) {
          setNoShowError(res.message ?? "That didn't go through. Nothing changed, so try again.");
          load();
          return;
        }
        setNoShowAsk(null);
        onChanged();
        load();
        if (res.notes && res.notes.length > 0) {
          setUndoneNotes(res.notes);
        } else {
          toast("Back on the calendar", "success");
        }
      } finally {
        noShowBusyRef.current = false;
        setNoShowBusy(false);
      }
    })();
  }

  //  ── "Didn't show up?" from Checkout ──
  // Drick, 2026-10-19: "Still doesnt let me charge card on file for someone
  // that missed appt" - from the Checkout screen, which offered only ways to
  // record a payment. The row goes into the SAME confirm the More menu opens
  // (no second path to a charge): a live booking's Mark no-show, or a visit
  // the sweep already completed's correction. The SERVER says which is open
  // (`noShowAllowed` / `correctable`) and what it does to the card
  // (`noShowCard`); a paid visit is not offered it.
  const checkoutNoShow: NoShowCardOutcome | null =
    detail !== null &&
    detail.source === "appointment" &&
    detail.origin === "chairback" &&
    detail.checkedOutAt === null &&
    detail.noShowCard != null &&
    ((detail.status === "upcoming" && detail.noShowAllowed === true) ||
      (detail.status === "completed" && detail.correctable === true))
      ? detail.noShowCard
      : null;

  function markNoShowFromCheckout() {
    if (!detail) return;
    setPayError(null);
    setView("detail");
    if (detail.status === "completed") askCorrect("no_show");
    else askNoShow("mark");
  }
  const checkoutNoShowRow = checkoutNoShow ? (
    <CheckoutNoShowRow outcome={checkoutNoShow} onMark={markNoShowFromCheckout} />
  ) : null;

  //  ── chrome ──────────────────────────────────────────────────────────────
  const title =
    view === "series"
      ? "This and future"
      : view === "edit"
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
          // Back from the dates is back to the fields, not out of the change.
          series: () => (series.stage === "review" ? series.back() : setView("detail")),
          charges: () => setView("detail"),
          pay: () => setView(newCheckout ? "detail" : "charges"),
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
    view === "series" ? (
      <SeriesEditFooter state={series} onClose={() => setView("detail")} />
    ) : view === "edit" ? (
      <EditFooter
        pending={edit.pending}
        disabled={!edit.ctx || !edit.dirty}
        error={edit.saveError}
        onCancel={() => setView("detail")}
        onSave={edit.save}
      />
    ) : view === "charges" ? (
      <TwoUp
        secondary={{ label: "Back", onClick: () => setView("detail") }}
        primary={{ label: "Next", onClick: () => setView("pay") }}
      />
    ) : view === "pay" ? (
      // CheckoutFlow owns its own actions - a second "pay" button down here
      // would be a way to charge from a step that has not shown the amount.
      // The ORIGINAL screen keeps the footer it always had.
      newCheckout ? null : (
        <div className="flex w-full flex-col gap-2">
          {payError && (
            <p role="alert" data-testid="checkout-error" className="text-sm text-danger-soft">
              {payError}
            </p>
          )}
          <TwoUp
            secondary={{
              label: "Back",
              onClick: () => {
                setPayError(null);
                setView("charges");
              },
            }}
            primary={{
              label:
                pending || saving
                  ? "Saving…"
                  : method
                    ? `Mark paid · $${parsedAmount !== null ? parsedAmount.toFixed(2) : "—"}`
                    : "Pick a payment method",
              onClick: submitCheckout,
              disabled: pending || saving || !method || !amountValid,
            }}
          />
        </div>
      )
    ) : lateCancelAsk && detail?.lateCancelCard && lateCancelAsksFirst(detail.lateCancelCard) ? (
      <LateCancelFooter
        outcome={detail.lateCancelCard}
        error={lateCancelError}
        busy={lateCancelBusy || pending}
        onLateCancel={confirmLateCancel}
        onCancelNoFee={() => {
          setLateCancelAsk(false);
          act(cancelAppointmentAction, "Canceled", true);
        }}
        onKeep={() => {
          setLateCancelAsk(false);
          setLateCancelError(null);
        }}
      />
    ) : cancelPastAsk && detail ? (
      <CancelPastFooter
        busy={noShowBusy || pending}
        onNoShow={() => {
          setCancelPastAsk(false);
          // The no-show's own footer carries its busy state and any refusal.
          setNoShowAsk("mark");
          confirmNoShowChange("mark");
        }}
        onCancelAnyway={() => {
          setCancelPastAsk(false);
          act(cancelAppointmentAction, "Canceled", true);
        }}
        onKeep={() => setCancelPastAsk(false)}
      />
    ) : noShowAsk && detail ? (
      <NoShowFooter
        detail={detail}
        kind={noShowAsk}
        error={noShowError}
        busy={noShowBusy}
        onKeep={() => {
          setNoShowAsk(null);
          setNoShowError(null);
        }}
        onConfirm={() => confirmNoShowChange()}
      />
    ) : undoneNotes ? (
      <UndoneNoShowFooter notes={undoneNotes} onDone={() => setUndoneNotes(null)} />
    ) : markedCard ? (
      <MarkedNoShowFooter
        kind={markedCard.kind}
        result={markedCard.result}
        last4={markedCard.last4}
        onDone={() => setMarkedCard(null)}
      />
    ) : confirmRemove && detail ? (
      <RemoveWalkInFooter
        detail={detail}
        error={removeError}
        removing={removing}
        onKeep={() => {
          setConfirmRemove(false);
          setRemoveError(null);
        }}
        onRemove={removeWalkIn}
      />
    ) : confirmCorrect && detail ? (
      <CorrectVisitFooter
        detail={detail}
        outcome={confirmCorrect}
        error={correctError}
        busy={correcting}
        onKeep={() => {
          setConfirmCorrect(null);
          setCorrectError(null);
        }}
        onConfirm={correctVisit}
      />
    ) : (
      <DetailFooter detail={detail} notice={savedNotice} onEdit={() => setView("edit")} />
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
      {view === "series" ? (
        <SeriesEditFields state={series} />
      ) : view === "edit" ? (
        <>
          {row.seriesId && (
            <p className="mb-3 px-1 text-sm text-muted" data-testid="edit-this-only">
              This changes this appointment only. To change the ones after it too, use More, then
              &ldquo;Edit this and future&rdquo;.
            </p>
          )}
          <AppointmentEditFields state={edit} />
        </>
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
        newCheckout ? (
          <CheckoutFlow
            appointmentId={row.id}
            timeZone={zone}
            onDone={() => {
              onChanged();
              load();
            }}
            onBackToAppointment={() => setView("detail")}
            reviewExtra={checkoutNoShowRow}
          />
        ) : (
          <PayView
            row={row}
            dateLabel={dateLabel}
            timeLabel={timeLabel}
            amount={amountValue}
            setAmount={(v) => {
              setPayError(null);
              setAmount(v);
            }}
            amountValid={amountValid}
            prepaidCents={prepaidCents}
            ticketCents={ticketCents}
            method={method}
            setMethod={(m) => {
              setPayError(null);
              setMethod(m);
            }}
            noShowRow={checkoutNoShowRow}
          />
        )
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
          onEditSeries={() => setView("series")}
          onCheckout={() => setView(newCheckout ? "pay" : "charges")}
          onChargeLateCancel={
            detail?.lateCancelCard?.charge && !appointmentEnded(detail.endsAt) ? openLateCancelAsk : undefined
          }
          feeDecision={
            detail?.cardFeeAwaiting
              ? { onDecide: decideWaitingFee, busy: feeDecisionBusy, error: feeDecisionError }
              : feeDecisionError
                ? { onDecide: decideWaitingFee, busy: false, error: feeDecisionError }
                : undefined
          }
          onBookAgain={
            canBookAgain && detail?.clientId
              ? () => {
                  // Who and what carry over - never the time, price, payment
                  // or status. This sheet closes: the form takes over, and
                  // this appointment is left exactly as it is.
                  requestRebook({
                    clientId: detail.clientId!,
                    clientLabel: detail.clientName,
                    serviceId: row.serviceId ?? null,
                    serviceName: detail.serviceName,
                    staffId: row.staffId ?? null,
                    staffName: detail.staffName,
                  });
                  onClose();
                }
              : undefined
          }
          onAct={act}
          onRemoveWalkIn={askRemoveWalkIn}
          onCorrect={askCorrect}
          onNoShow={askNoShow}
          onCancel={cancelOrAsk}
          onPriceSaved={() => {
            onChanged();
            load();
          }}
          onTipSaved={(message) => {
            // In the footer, not a toast: a toast draws beneath this sheet
            // and is invisible on a phone.
            setSavedNotice({ message, tone: "success" });
            onChanged();
            load();
          }}
          showRefunds={newCheckout}
          onDepositRefunded={(message) => {
            setSavedNotice({ message, tone: "success" });
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
  onEditSeries,
  onCheckout,
  onChargeLateCancel,
  feeDecision,
  onBookAgain,
  onAct,
  onRemoveWalkIn,
  onCorrect,
  onNoShow,
  onCancel,
  onPriceSaved,
  onTipSaved,
  showRefunds,
  onDepositRefunded,
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
  onEditSeries: () => void;
  onCheckout: () => void;
  /** Ask "did the client cancel?" with the fee; absent when no fee is due. */
  onChargeLateCancel?: () => void;
  /** Charge or Waive a client's late-cancel fee that waited for approval. */
  feeDecision?: FeeDecisionProps;
  /** Start this client's next visit; absent where Book again isn't offered. */
  onBookAgain?: () => void;
  onAct: (
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
    closeAfter?: boolean,
  ) => void;
  /** Ask, in the sheet, whether to remove this walk-in. */
  onRemoveWalkIn: () => void;
  /** Ask, in the sheet, whether to mark this completed visit a no-show or cancel it. */
  onCorrect: (outcome: "no_show" | "canceled") => void;
  /** Ask, in the sheet, whether to mark this booking a no-show, or to undo one. */
  onNoShow: (kind: "mark" | "undo") => void;
  /** Cancel this one booking - asking first, in the footer, once it has ended. */
  onCancel: () => void;
  /** The price changed on the server: re-read the booking and the agenda. */
  onPriceSaved: () => void;
  /** A tip was recorded, changed or taken off: say so in the footer, then re-read. */
  onTipSaved: (message: string) => void;
  /** The new checkout is live for this shop, so its card payments can be refunded here. */
  showRefunds: boolean;
  /** Money went back to a customer: say so in the footer, then re-read. */
  onDepositRefunded: (message: string) => void;
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
        onTipSaved={onTipSaved}
        onTipStale={onRetry}
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
            onChargeLateCancel={onChargeLateCancel}
            feeDecision={feeDecision}
          />
          {/* What a cancelled or no-show booking kept from its booking
              payment. NOT behind the checkout flag: every deposit-mode shop
              takes money at booking. The server decides when there is
              anything to give back (`keptDeposit`); the panel only shows it. */}
          {!loadError && detail?.source === "appointment" && detail.keptDeposit && (
            <DepositRefund
              appointmentId={detail.id}
              status={detail.status}
              kept={detail.keptDeposit}
              onRefunded={onDepositRefunded}
              onStale={onRetry}
            />
          )}
          {/* A tip the client left online after the visit, while any of it
              can still be given back. Managers only, like everything here. */}
          {!loadError && detail?.source === "appointment" && detail.tip && detail.tip.refundableCents > 0 && (
            <TipRefund
              appointmentId={detail.id}
              tip={detail.tip}
              onRefunded={onDepositRefunded}
              onStale={onRetry}
            />
          )}
          {/* Only where the new checkout is live, and only for a ChairBack
              booking - another platform's payments are refunded there. Renders
              nothing unless a card payment from this checkout exists. */}
          {showRefunds && detail?.source === "appointment" && detail.origin === "chairback" && (
            <CheckoutRefund appointmentId={detail.id} onRefunded={onDepositRefunded} />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <ClientCard
            detail={detail}
            loadError={loadError}
            zoneDiffers={zoneDiffers}
            browserZone={browserZone}
          />
          {/* 🔴 WHAT THE JOB NEEDS, ABOVE THE BARBER'S OWN NOTE. For a mobile
              mechanic this panel IS the job: the address he is driving to and
              the vehicle he is quoting. It reads from the booking's own frozen
              answers, so it keeps saying what the customer told him even after
              he has since reworded or removed the question. */}
          {detail?.intake && detail.intake.length > 0 && (
            <Panel title="What they told you">
              <dl className="flex flex-col gap-2.5">
                {detail.intake.map((a, i) => (
                  <div key={`${a.label}-${i}`} className="min-w-0">
                    <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                      {a.label}
                    </dt>
                    <dd className="[overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-relaxed text-offwhite/85">
                      {a.kind === "address" ? (
                        // An address is somewhere he has to GET to, so it is a
                        // tap that opens his maps app, not text to retype.
                        <a
                          href={`https://maps.google.com/?q=${encodeURIComponent(a.value)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gold transition-colors hover:text-gold-muted"
                        >
                          {a.value}
                        </a>
                      ) : (
                        a.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}
          {/* What the customer agreed to on the booking page - the owner's
              own checklist, as it read THEN. Frozen, like the answers above. */}
          {detail?.policyAgreement && (
            <Panel title="Your policies">
              <p className="text-sm text-offwhite/85">
                {/* Two different facts, so two sentences: a customer who was
                    not shown the boxes this time must never read as one who
                    ticked them on this booking. */}
                {detail.policyAgreement.agreedEarlierAt ? (
                  <>
                    Agreed to your policies when they first booked,{" "}
                    {fmtDay(detail.policyAgreement.agreedEarlierAt, detail.timezone)}. Not asked
                    again this time: the wording hasn&apos;t changed since.
                  </>
                ) : (
                  <>
                    Agreed to your policies when booking,{" "}
                    {fmtDay(detail.policyAgreement.acceptedAt, detail.timezone)}.
                  </>
                )}
              </p>
              {detail.policyAgreement.checklist.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {detail.policyAgreement.checklist.map((line, i) => (
                    <li
                      key={`${i}-${line}`}
                      className="flex min-w-0 items-start gap-2 text-sm text-offwhite/85"
                    >
                      <span aria-hidden="true" className="shrink-0 text-emerald-soft">
                        ✓
                      </span>
                      <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              {detail.policyAgreement.text && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-muted">
                    The policy they read
                  </summary>
                  <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                    {detail.policyAgreement.text}
                  </p>
                </details>
              )}
            </Panel>
          )}
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
          onBookAgain={onBookAgain}
          onEditSeries={() => {
            setMenu(null);
            onEditSeries();
          }}
          onAct={onAct}
          onRemoveWalkIn={onRemoveWalkIn}
          onCorrect={onCorrect}
          onNoShow={(kind) => {
            setMenu(null);
            onNoShow(kind);
          }}
          onCancel={() => {
            setMenu(null);
            onCancel();
          }}
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
  onTipSaved,
  onTipStale,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  dateLabel: string;
  timeLabel: string;
  durMin: number | null;
  toast: Toast;
  onPriceSaved: () => void;
  onTipSaved: (message: string) => void;
  onTipStale: () => void;
}) {
  const vocab = useVocab();
  const priceEdit = usePriceEdit({ row, detail, toast, onSaved: onPriceSaved });
  const tipEdit = useTipEdit({ row, detail, onSaved: onTipSaved, onStale: onTipStale });
  // The Tip row: only for a ChairBack booking whose read carries it (an older
  // API omits `tips`, and a synced booking's tips live where it was booked).
  const tips =
    detail?.source === "appointment" && detail.origin === "chairback" ? (detail.tips ?? null) : null;
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
  const addOns = detail?.addOns ?? row.addOns ?? [];
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
        {detail?.clientInstagram && (
          <p className="mt-1 text-sm">
            <InstagramHandle handle={detail.clientInstagram} />
          </p>
        )}
        {/* A group member points at the booker's client: labelled, never
            shown bare under the attendee's name as if it were theirs. */}
        {detail?.bookedByInstagram && (
          <p className="mt-1 text-sm text-muted">
            Booked by <InstagramHandle handle={detail.bookedByInstagram} />
          </p>
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
              external ? "bg-info-soft/15 text-info-soft" : "bg-charcoal-700 text-muted",
            )}
          >
            {sourceLabel}
          </span>
          {/* "Repeats", not "Weekly": a series can be every 1 to 8 weeks. */}
          {row.seriesId && (
            <span
              title="Repeat appointment"
              className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] font-medium text-gold"
            >
              ↻ Repeats
            </span>
          )}
          {row.special && <SpecialChip afterHours={row.afterHours} premium={row.premium} className="px-2.5 py-1" />}
        </div>
      </div>

      {/* The booking's own facts. Label left, value right, wrapping to its own
          line before anything compresses — a 40-character service name pushes
          the price down, it never squeezes it. */}
      <dl className="relative border-t border-subtle px-4 py-2.5 text-sm sm:px-6">
        <Fact icon={<TagIcon />} label="Service">
          <span className="[overflow-wrap:anywhere]">
            {service ?? "Appointment"}
            {addOns.map((a) => ` + ${a.name}`).join("")}
          </span>
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
        {tips && (
          <Fact icon={<TipIcon />} label="Tip">
            {tips.totalCents > 0 ? (
              <>
                <span className="tabular-nums" data-qa="tip-total">
                  {formatTipCents(tips.totalCents)}
                </span>
                <span className="text-muted"> · {tipSourceLabel(tips)}</span>
              </>
            ) : (
              <span className="text-muted" data-qa="tip-total">
                None yet
              </span>
            )}
            {tipEdit.allowed && !tipEdit.open && (
              <button
                type="button"
                onClick={tipEdit.begin}
                data-qa="tip-edit"
                aria-label={tips.recordedCents > 0 ? "Edit recorded tip" : "Add a tip you received"}
                className="ml-2 inline-flex h-11 items-center rounded-md px-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 sm:h-7"
              >
                {tips.recordedCents > 0 ? "Edit" : "Add"}
              </button>
            )}
          </Fact>
        )}
      </dl>
      {priceEdit.open && <PriceEditor state={priceEdit} />}
      {tipEdit.open && <TipEditor state={tipEdit} />}
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
                : res.error === "stale_price"
                  ? "This booking changed while you were editing. Close and reopen it to see the current price."
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
  // "Chair" is a barbershop word: a salon says station, a spa says room. The
  // vocabulary provider owns it; nothing here may spell it out.
  const vocab = useVocab();
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
            Collected at the {vocab.stationNoun}
            <input
              inputMode="decimal"
              value={state.collected}
              onChange={(e) => state.setCollected(e.target.value)}
              onKeyDown={onKey}
              aria-label={`Collected at the ${vocab.stationNoun}, in dollars`}
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
 * Where the visit's tips came from, in a word or two: "Cash", "paid online",
 * "online + cash". The amounts themselves are the server's (detail `tips`).
 */
function tipSourceLabel(tips: NonNullable<AppointmentDetail["tips"]>): string {
  const recorded =
    tips.recordedCents > 0 && tips.recordedMethod
      ? (RECORDED_TIP_METHOD_LABEL[tips.recordedMethod as RecordedTipMethod] ?? "Recorded")
      : null;
  if (tips.onlineCents > 0 && recorded) return `online + ${recorded.toLowerCase()}`;
  if (tips.onlineCents > 0) return "paid online";
  return recorded ?? "";
}

/**
 * THE TIP ROW'S EDITOR: record a tip the barber was HANDED - cash at the chair,
 * or money sent through another app. A record only: nothing here, or in the
 * route behind it, charges a card. A card tip is the client's own, from their
 * appointment page, and arrives on its own.
 *
 * 🔴 ONE REQUEST PER TAP. `busy` is a ref, set before the first await and read
 * before anything else, so a second tap - or Enter pressed while the first
 * save is in flight - sends nothing. `saving` only draws "Saving…": React's
 * transition `pending` does not stay on across an awaited call, so it guards
 * nothing. The server is idempotent too (the same request twice records once),
 * but the sheet does not lean on it.
 *
 * The outcome goes to the sheet's footer (onSaved); a refusal stays inline,
 * here. Never a toast - one drawn from inside a dialog is invisible on a phone.
 */
type TipEditState = {
  allowed: boolean;
  open: boolean;
  amount: string;
  method: RecordedTipMethod;
  /** The recorded tip the sheet is showing, in cents; 0 = none recorded. */
  recordedCents: number;
  error: string | null;
  saving: boolean;
  begin: () => void;
  cancel: () => void;
  setAmount: (v: string) => void;
  setMethod: (m: RecordedTipMethod) => void;
  save: () => void;
  remove: () => void;
};

function tipRefusalCopy(error: string | undefined): string {
  switch (error) {
    case "stale_tip":
      return "This tip was changed on another device. The sheet now shows the latest - check it and save again.";
    case "not_tippable":
      return "This booking can't take a tip - it was cancelled or marked a no-show.";
    case "external":
      return "This booking's tips live where it was booked.";
    case "forbidden_role":
      return "Only an owner or manager can record tips.";
    case "invalid_input":
      return `Enter a tip from $0.01 to ${formatTipCents(RECORDED_TIP_MAX_CENTS)}.`;
    default:
      return "Couldn't save the tip. Nothing was charged - try again.";
  }
}

function useTipEdit({
  row,
  detail,
  onSaved,
  onStale,
}: {
  row: AgendaRow;
  detail: AppointmentDetail | null;
  onSaved: (message: string) => void;
  onStale: () => void;
}): TipEditState {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<RecordedTipMethod>("cash");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const tips = detail?.source === "appointment" ? (detail.tips ?? null) : null;
  const allowed = tips !== null && tips.recordable;
  const recordedCents = tips?.recordedCents ?? 0;

  function begin() {
    setAmount(recordedCents > 0 ? (recordedCents / 100).toFixed(2) : "");
    setMethod(tips?.recordedMethod === "other" ? "other" : "cash");
    setError(null);
    setOpen(true);
  }
  function cancel() {
    if (busy.current) return;
    setOpen(false);
    setError(null);
  }

  async function send(input: Parameters<typeof recordTipAction>[1], success: string): Promise<void> {
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      let res: Awaited<ReturnType<typeof recordTipAction>>;
      try {
        res = await recordTipAction(row.id, input);
      } catch {
        setError("No answer - check your connection and try again. Nothing was charged.");
        return;
      }
      if (!res.ok) {
        setError(tipRefusalCopy(res.error));
        if (res.error === "stale_tip") onStale();
        return;
      }
      setOpen(false);
      onSaved(success);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  function save() {
    if (busy.current) return;
    const cents = tipDollarsToCents(amount);
    if (cents === null || !recordedTipAllowed(cents)) {
      setError(`Enter a tip from $0.01 to ${formatTipCents(RECORDED_TIP_MAX_CENTS)}, like 10 or 7.50.`);
      return;
    }
    void send(
      { amountCents: cents, method, expectedCents: recordedCents > 0 ? recordedCents : null },
      `Tip recorded: ${formatTipCents(cents)} · ${RECORDED_TIP_METHOD_LABEL[method]}. No card was charged.`,
    );
  }

  function remove() {
    if (busy.current || recordedCents <= 0) return;
    void send({ amountCents: null, expectedCents: recordedCents }, "Recorded tip removed.");
  }

  return {
    allowed,
    open,
    amount,
    method,
    recordedCents,
    error,
    saving,
    begin,
    cancel,
    setAmount: (v) => {
      setAmount(v);
      setError(null);
    },
    setMethod,
    save,
    remove,
  };
}

function TipEditor({ state }: { state: TipEditState }) {
  // Escape cancels THIS, not the whole sheet (Dialog listens for Escape too).
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
    <div className="relative border-t border-subtle px-4 py-3 sm:px-6" data-qa="tip-editor">
      <p className="text-xs text-muted">
        Record a tip you were handed in cash or sent in another app. Nothing is charged to a card.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          Tip
          <input
            autoFocus
            inputMode="decimal"
            value={state.amount}
            onChange={(e) => state.setAmount(e.target.value)}
            onKeyDown={onKey}
            aria-label="Tip in dollars"
            placeholder="10.00"
            className={cn(INPUT, "tabular-nums")}
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1 text-xs text-muted">
          <span id="tip-method-label">Received as</span>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="tip-method-label">
            {(["cash", "other"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={state.method === m}
                onClick={() => state.setMethod(m)}
                className={cn(
                  "h-11 rounded-lg border px-3 text-sm transition-colors duration-150 ease-out sm:h-9",
                  state.method === m
                    ? "border-gold bg-gold/10 text-offwhite"
                    : "border-subtle text-muted hover:bg-charcoal-700 hover:text-offwhite",
                )}
              >
                {RECORDED_TIP_METHOD_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {state.error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-soft">
          {state.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap justify-end gap-2">
        {state.recordedCents > 0 && (
          <button
            type="button"
            onClick={state.remove}
            disabled={state.saving}
            data-qa="tip-remove"
            className="mr-auto h-11 rounded-lg px-3 text-sm text-danger-soft transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-60 sm:h-9"
          >
            Remove tip
          </button>
        )}
        <button
          type="button"
          onClick={state.cancel}
          disabled={state.saving}
          className="h-11 rounded-lg border border-subtle px-3 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite sm:h-9"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={state.save}
          disabled={state.saving}
          data-qa="tip-save"
          className="h-11 rounded-lg bg-gold px-3 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold/90 disabled:opacity-60 sm:h-9"
        >
          {state.saving ? "Saving…" : "Save tip"}
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
  onChargeLateCancel,
  feeDecision,
}: {
  detail: AppointmentDetail | null;
  loadError: boolean;
  canCheckout: boolean;
  onCheckout: () => void;
  onChargeLateCancel?: () => void;
  feeDecision?: FeeDecisionProps;
}) {
  const vocab = useVocab();
  if (loadError) return null;
  if (!detail) return <CardSkeleton title="Payment" rows={3} />;

  const p = detail.payment;
  const external = p.state === "external";
  const settled = p.state === "paid";
  // 🔴 A CANCELLED OR NO-SHOW BOOKING HAS NOTHING LEFT TO COLLECT. The summary
  // does not know the booking's status, so on its own it read a cancelled $40
  // booking with a $10 deposit kept as "Part paid · $30.00 · still to
  // collect". Closed, the headline is what was paid and not given back.
  const closed = !external && (detail.status === "canceled" || detail.status === "no_show");
  // A no-show or late-cancel fee taken from the card on file is its own
  // payment, deliberately outside the service's money - so a closed booking
  // with only that fee must not read "Nothing paid".
  const fee = p.cardOnFile?.status ?? null;

  const eyebrow = external
    ? `Managed in ${detail.originLabel}`
    : p.state === "refunded"
      ? "Refunded"
      : closed
        ? detail.status === "no_show"
          ? "No-show"
          : "Cancelled"
        : p.state === "paid"
          ? "Settled"
          : p.state === "deposit"
            ? "Part paid"
            : "Ready for checkout";

  const headline = external
    ? "Managed externally"
    : p.state === "refunded"
      ? money(p.refundedCents)
      : closed
        ? p.collectedCents > 0
          ? money(p.collectedCents)
          : fee === "charged"
            ? "Fee charged"
            : fee === "charging"
              ? "Fee being confirmed"
              : "Nothing paid"
        : settled
          ? "Paid in full"
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
        {!external && !closed && !settled && p.remainingCents !== null && p.remainingCents > 0 && (
          <p className="mt-0.5 text-[11px] text-muted">still to collect</p>
        )}
        {closed && p.state !== "refunded" && p.collectedCents > 0 && (
          <p className="mt-0.5 text-[11px] text-muted">paid and not refunded</p>
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
          {/* PROOF of a fee taken from the card on file, kept after the
              moment-of-charge footer is gone: what, how much, which card,
              when, and whether Stripe actually took it. */}
          {detail.cardFee && <CardFeeLine fee={detail.cardFee} timezone={detail.timezone} />}
          {/* A fee that waited for approval and was waived (or lapsed). */}
          {!detail.cardFee && detail.cardFeeWaivedAt && (
            <div data-testid="card-fee-waived">
              <Line label="Late-cancel fee" value="Waived · not charged" />
            </div>
          )}
          {p.refundedCents > 0 && (
            <Line label="Refunded" value={`−${money(p.refundedCents)}`} tone="bad" />
          )}
          {/* An authorization is a card being HELD, not money in the shop. */}
          {p.authorizedCents > 0 && (
            <Line label="Card held (not captured)" value={money(p.authorizedCents)} />
          )}
          {/* 🔴 A TIP IS ITS OWN LINE, never part of the figures above: it is
              the client's extra on top of the price, so it never changes what
              is paid or still to collect. Stripe's fee comes out of it. */}
          {detail.tip && (
            <>
              <Line
                label={detail.tip.processing ? "Tip · processing" : "Tip · paid online"}
                value={money(detail.tip.amountCents)}
                tone="good"
              />
              <Line label="Stripe's fee on the tip" value={`−${money(detail.tip.feeCents)}`} />
              {detail.tip.refundedCents > 0 && (
                <Line label="Tip refunded" value={`−${money(detail.tip.refundedCents)}`} tone="bad" />
              )}
            </>
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
          {/* The fee's outcome is a money fact even when no brand/last-four
              was recorded (a wallet or a failed card lookup), so it still
              says what happened - without inventing a card. */}
          {!p.card && (fee === "charged" || fee === "failed") && (
            <Line
              label={fee === "charged" ? "Fee charged" : "Fee declined - collect at the next visit"}
              value="Card on file"
              tone={fee === "failed" ? "bad" : undefined}
            />
          )}
          {/* Asked for a card and booked without one (the card step is
              optional): say so, because a no-show fee needs a card. Booked
              only - a held request is still waiting on its card, not skipped. */}
          {fee === "pending" && detail.status === "upcoming" && (
            <Line label="No card on file" value="Skipped at booking" />
          )}
        </dl>
      )}

      {/* 🔴 THE CLIENT CANCELLED, AND THE FEE WAITS FOR A YES. Nothing was
          charged when they cancelled (Shop.cardFeeNeedsApproval): this is the
          question, with the figure and the card, and both answers. */}
      {feeDecision && (detail.cardFeeAwaiting || feeDecision.error) && (
        <CardFeeApproval
          waiting={detail.cardFeeAwaiting ?? null}
          timezone={detail.timezone}
          {...feeDecision}
        />
      )}

      {/* 🔴 THE LATE-CANCEL FEE, WHERE A BARBER LOOKS FOR A CHARGE. A client
          who cancels by text never touches their link; the barber charges the
          fee here, on this booking's own terms (never a typed amount). It only
          opens the ask in the footer - nothing is charged on this tap. */}
      {onChargeLateCancel && detail.lateCancelCard?.charge && (
        <div className="mt-3.5 flex flex-col gap-1.5 border-t border-subtle pt-3.5">
          <button
            type="button"
            onClick={onChargeLateCancel}
            data-testid="charge-late-cancel"
            className="flex h-11 w-full items-center justify-center rounded-xl border border-danger-soft/50 px-5 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
          >
            {`Charge late-cancel fee · ${money(detail.lateCancelCard.cents)}`}
          </button>
          <p className="px-1 text-[11px] leading-relaxed text-muted">
            Client cancelled inside your window?{" "}
            {detail.lateCancelCard.last4
              ? `Charges the card ending ${detail.lateCancelCard.last4}`
              : "Charges the card they saved"}{" "}
            and cancels the appointment.
          </p>
        </div>
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
              <span className="mt-0.5 block text-[11px] leading-snug text-warning-soft/90">
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
    tone: "text-warning-soft",
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
          // Only when focus MOVED TO something outside the menu. Moving between
          // items fires blur too, with relatedTarget still inside.
          //
          // 🔴 A NULL relatedTarget IS NOT "FOCUS LEFT". On iOS, tapping a link
          // does not focus it, but it DOES blur whatever was focused — so the
          // first row, auto-focused when the menu opens, blurs with a null
          // relatedTarget the instant the barber taps any OTHER row. Reading
          // that as "left the menu" closed the menu and unmounted the very
          // anchor being tapped, before Safari could follow its href: Text and
          // Email did nothing at all, while Call — the focused row, which never
          // blurs — worked. Escape and the scrim still close, so nothing traps.
          const next = e.relatedTarget as Node | null;
          if (next && !e.currentTarget.contains(next)) onClose();
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
  // ONE TAP, ONE HANDOFF. A device row stays mounted through its own tap (see
  // the href branch), so a second tap would otherwise open a second draft.
  const fired = useRef(false);
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
        onClick={(e) => {
          if (fired.current) {
            e.preventDefault();
            return;
          }
          fired.current = true;
          // 🔴 DO NOT CLOSE IN THIS TICK. React flushes a click's state update
          // synchronously, so closing here unmounts this <a> while the browser
          // is still dispatching — and a disconnected anchor never follows its
          // href. Handing the close to a later task keeps the node connected
          // through the OS handoff and still reads as instant.
          //
          // It is also why this is a real anchor and not a button that assigns
          // location: the navigation stays the user's own tap, which is the
          // only kind iOS lets through to Messages, Phone and Mail.
          setTimeout(onDone, 0);
        }}
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
 * rendered at all. Every URI comes from `lib/contactUri`, which returns null
 * for anything it cannot make dialable; a row exists only when its handoff
 * would really work.
 *
 * 🔴 MISSING CONSENT DOES NOT GATE TEXT. AN EXPLICIT OPT-OUT DOES. Those are
 * two different facts about a client and they do not deserve the same answer:
 *
 *   no_consent — nobody ever asked them. `sms:` sends nothing: it opens the
 *                barber's OWN Messages app, empty, and they write and send it
 *                themselves from their own number, so there is nothing here
 *                for consent to govern. Blocking it disabled the common case
 *                — every Acuity-synced client starts in this state, so a
 *                migrating shop had a dead Text row for its whole book —
 *                while preventing nothing, because Call and Copy phone number
 *                hand over the same number, ungated, one tap away.
 *   opted_out  — they texted STOP. That is a person telling this shop to stop
 *                texting them, and it does not stop being true because the
 *                message would leave from a different app. Text is DISABLED,
 *                and stays VISIBLE saying why: a hidden row reads as a missing
 *                number, and the barber needs to know this is not theirs to
 *                undo. Only the client can, with START.
 *
 * 🔴 A CALL IS NOT A TEXT. An opt-out is consent to be TEXTED withdrawn, so
 * Call stays live in that state — and so does Copy phone number.
 *
 * Whether AUTOMATED texts will send is a third question again, and the Client
 * panel above answers it in every state.
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
  const tel = telUri(phone);
  const sms = smsUri(phone);
  const mail = mailtoUri(email);

  const copy = useCallback(
    async (kind: "phone" | "email", value: string) => {
      const ok = await copyText(value);
      toast(
        ok
          ? kind === "phone"
            ? "Phone number copied"
            : "Email copied"
          : "Couldn't copy — press and hold to select it instead",
        ok ? "success" : "error",
      );
    },
    [toast],
  );

  const items: MenuItem[] = [];
  if (tel) {
    items.push({
      key: "call",
      label: "Call",
      icon: <PhoneIcon />,
      href: tel,
    });
  }
  if (sms) {
    const optedOut = detail.sms.state === "opted_out";
    items.push({
      key: "text",
      label: "Text",
      icon: <ChatIcon />,
      // "They texted STOP. Only they can undo it, with START" - the same words
      // the Client panel uses, because it is the same fact.
      ...(optedOut
        ? { disabled: true, reason: SMS_COPY.opted_out.detail }
        : { href: sms }),
    });
  }
  if (mail) {
    items.push({
      key: "email",
      label: "Email",
      icon: <MailIcon />,
      href: mail,
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
  if (mail && email) {
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
  onBookAgain,
  onEditSeries,
  onAct,
  onRemoveWalkIn,
  onCorrect,
  onNoShow,
  onCancel,
}: {
  row: AgendaRow;
  detail: AppointmentDetail;
  onClose: () => void;
  onEdit: () => void;
  onBookAgain?: () => void;
  onEditSeries: () => void;
  onAct: (
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
    closeAfter?: boolean,
  ) => void;
  onRemoveWalkIn: () => void;
  onCorrect: (outcome: "no_show" | "canceled") => void;
  onNoShow: (kind: "mark" | "undo") => void;
  onCancel: () => void;
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
  // The client's NEXT visit, from this one - whatever its status, and most of
  // all a finished cut, booked while they are still in the chair. ChairBack's
  // own bookings only: an Acuity or Square booking's client and service live
  // in that platform, and the visit should be booked there.
  if (native && detail.clientId && onBookAgain) {
    items.push({ key: "rebook", label: "Book again", icon: <CalendarIcon />, onClick: onBookAgain });
  }
  if (detail.editable) {
    items.push({ key: "edit", label: "Edit appointment", icon: <PencilIcon />, onClick: onEdit });
  }
  // A repeat's later visits, changed together. Only a confirmed ChairBack
  // visit can start it: a request or a card step is not settled yet, and a
  // synced visit is changed where it lives.
  if (row.seriesId && native && detail.status === "upcoming" && detail.editable) {
    items.push({
      key: "edit-series",
      label: "Edit this and future",
      icon: <PencilIcon />,
      onClick: onEditSeries,
    });
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
    // Only once its start has come - the SERVER says so (`noShowAllowed`);
    // before then the route refuses and Cancel is the honest action. It asks
    // first, in the sheet, with any fee it would charge.
    if (detail.noShowAllowed !== false) {
      items.push({
        key: "no-show",
        label: "Mark no-show",
        icon: <EmptyChairIcon />,
        onClick: () => onNoShow("mark"),
      });
    }
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
      onClick: onCancel,
    });
  }
  // A walk-in recorded by mistake - the only finished visit that can be taken
  // back off the books. The SERVER says it is a walk-in (`walkIn`); a service
  // that happens to be called "Walk-in" never decides it. It asks first, in
  // the sheet.
  if (native && detail.walkIn === true && detail.status === "completed") {
    items.push({
      key: "remove-walk-in",
      divided: true,
      label: "Remove walk-in",
      icon: <BanIcon />,
      tone: "danger",
      onClick: onRemoveWalkIn,
    });
  }
  // A completed visit that never happened - the 15-minute sweep finishes every
  // booking whose time has passed, so a no-show not marked in time reads as
  // done. The SERVER says it may still be put right (`correctable`: ChairBack's
  // own, recent, no money on it). Each asks first, in the sheet.
  if (native && detail.correctable === true && detail.status === "completed") {
    items.push({
      key: "correct-no-show",
      divided: true,
      label: "Mark no-show",
      icon: <EmptyChairIcon />,
      onClick: () => onCorrect("no_show"),
    });
    items.push({
      key: "correct-cancel",
      label: "Cancel visit",
      icon: <BanIcon />,
      tone: "danger",
      onClick: () => onCorrect("canceled"),
    });
  }
  // A no-show marked by mistake, put back on the calendar - when the SERVER
  // says it can be (`undoNoShow`: ChairBack's own, recent, nothing in flight).
  if (native && detail.status === "no_show" && detail.undoNoShow === true) {
    items.push({
      key: "undo-no-show",
      divided: true,
      label: "Undo no-show",
      icon: <CheckIcon />,
      onClick: () => onNoShow("undo"),
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
  noShowRow,
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
  /** "Didn't show up? Mark no-show" - only when the server says it can be. */
  noShowRow?: React.ReactNode;
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

      {noShowRow}

      <p className="text-center text-[11px] leading-relaxed text-muted">
        Records the sale and marks the {vocab.serviceNoun} done. ChairBack never touches the money —
        you keep 100%.
      </p>
    </div>
  );
}

//  ── footers ───────────────────────────────────────────────────────────────

/**
 * "Remove walk-in?" - asked in the footer, which never scrolls away, saying
 * exactly what will happen before anything does. A refusal (a card payment or
 * tip still on it) is read here too, in the server's own words.
 */
function RemoveWalkInFooter({
  detail,
  error,
  removing,
  onKeep,
  onRemove,
}: {
  detail: AppointmentDetail;
  error: string | null;
  removing: boolean;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const day = sameShopDay(detail.startsAt, new Date().toISOString(), detail.timezone)
    ? "today's takings"
    : "that day's takings";
  return (
    <div className="flex w-full flex-col gap-2" data-testid="remove-walk-in-confirm">
      <p className="text-sm font-medium text-offwhite">Remove this walk-in?</p>
      <p className="text-xs leading-relaxed text-muted">
        It comes off your schedule and out of {day}. Any punches it earned come off. Nobody is told.
      </p>
      {error && (
        <p role="alert" data-testid="remove-walk-in-error" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onKeep}
          disabled={removing}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
        >
          Keep it
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
        >
          {removing ? "Removing…" : "Remove walk-in"}
        </button>
      </div>
    </div>
  );
}

/**
 * "Mark this visit a no-show?" / "Cancel this visit?" - for a visit already
 * counted as completed. Asked in the footer, saying exactly what happens and
 * what does not, and a refusal (money on it, too long ago) is read here too,
 * in the server's own words.
 */
/**
 * Cancel, when card fees are on for this booking. With a fee due: did the
 * CLIENT cancel? "Yes" charges the fee on this booking's own terms; "No" is
 * the ordinary shop cancel, which never charges and refunds any deposit in
 * full. With no fee possible, it says why before cancelling, so a barber
 * expecting a charge is never left guessing.
 */
function LateCancelFooter({
  outcome,
  error,
  busy,
  onLateCancel,
  onCancelNoFee,
  onKeep,
}: {
  outcome: LateCancelCardOutcome;
  error: string | null;
  busy: boolean;
  onLateCancel: () => void;
  onCancelNoFee: () => void;
  onKeep: () => void;
}) {
  if (!outcome.charge) {
    const said = describeLateCancelCardOutcome(outcome);
    return (
      <div className="flex w-full flex-col gap-2" data-testid="late-cancel-no-fee">
        <p className="text-sm font-medium text-offwhite">Cancel with no fee?</p>
        <p className="text-xs leading-relaxed text-muted">{said.text}</p>
        {said.settingsLink && <FeeSettingsLink />}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancelNoFee}
            disabled={busy}
            className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            Cancel appointment
          </button>
          <button
            type="button"
            onClick={onKeep}
            disabled={busy}
            className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Keep it
          </button>
        </div>
      </div>
    );
  }
  const fee = outcome.cents % 100 === 0 ? `$${outcome.cents / 100}` : `$${(outcome.cents / 100).toFixed(2)}`;
  return (
    <div className="flex w-full flex-col gap-2" data-testid="late-cancel-confirm">
      <p className="text-sm font-medium text-offwhite">Did the client cancel?</p>
      <p className="text-xs leading-relaxed text-muted">
        {describeLateCancelCardOutcome(outcome).text} It&apos;s inside your cancellation window, so the client agreed
        to this fee when they booked, and they get an email receipt. If you&apos;re the one cancelling, cancel with no
        fee.
      </p>
      {error && (
        <p role="alert" data-testid="late-cancel-error" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onLateCancel}
        disabled={busy}
        className="flex h-11 w-full items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
      >
        {busy ? "Charging…" : `Client cancelled · charge ${fee}`}
      </button>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancelNoFee}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
        >
          Cancel, no fee
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * Cancel on an appointment that already ENDED: asked in the footer, with the
 * no-show beside it. Before the end, Cancel is one tap as it always was.
 */
function CancelPastFooter({
  busy,
  onNoShow,
  onCancelAnyway,
  onKeep,
}: {
  busy: boolean;
  onNoShow: () => void;
  onCancelAnyway: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2" data-testid="cancel-past-confirm">
      <p className="text-sm leading-relaxed text-offwhite">{CANCEL_PAST_END_COPY}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onNoShow}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
        >
          Mark no-show
        </button>
        <button
          type="button"
          onClick={onCancelAnyway}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
        >
          Cancel anyway
        </button>
      </div>
      <button
        type="button"
        onClick={onKeep}
        disabled={busy}
        className="h-11 w-full rounded-xl text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
      >
        Keep it
      </button>
    </div>
  );
}

function CorrectVisitFooter({
  detail,
  outcome,
  error,
  busy,
  onKeep,
  onConfirm,
}: {
  detail: AppointmentDetail;
  outcome: "no_show" | "canceled";
  error: string | null;
  busy: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const day = sameShopDay(detail.startsAt, new Date().toISOString(), detail.timezone)
    ? "today's takings"
    : "that day's takings";
  const action = outcome === "no_show" ? "Mark no-show" : "Cancel visit";
  // A no-show keeps a deposit paid at booking exactly as it is (the server
  // allows that one payment, and only for a no-show), so it stays counted.
  const keepsDeposit = outcome === "no_show" && detail.payment.onlineCents > 0;
  // A no-show after the fact charges nothing; the server says why, so a barber
  // looking to charge the card is told the real reason, not just "no fee".
  const why =
    outcome === "no_show" && detail.noShowCard && !detail.noShowCard.charge
      ? describeNoShowCardOutcome(detail.noShowCard)
      : null;
  return (
    <div className="flex w-full flex-col gap-2" data-testid="correct-visit-confirm">
      <p className="text-sm font-medium text-offwhite">
        {outcome === "no_show" ? "Mark this visit a no-show?" : "Cancel this visit?"}
      </p>
      <p className="text-xs leading-relaxed text-muted">
        {keepsDeposit
          ? `It comes off your completed visits, and only its deposit stays in ${day}, kept as it is.`
          : `It comes off your completed visits and out of ${day}.`}{" "}
        Any punch it earned comes off.{" "}
        {why ? "Nobody is told." : "Nobody is told, and no fee is charged."}
      </p>
      {why && (
        <p className="text-xs leading-relaxed text-offwhite" data-testid="correct-visit-card">
          {why.text}
        </p>
      )}
      {why?.settingsLink && <FeeSettingsLink />}
      {error && (
        <p role="alert" data-testid="correct-visit-error" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
        >
          Keep it
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : action}
        </button>
      </div>
    </div>
  );
}

/**
 * Mark no-show / Undo no-show, asked in the footer. Mark says exactly what a
 * kept card is charged (the server's figure, `noShowFee`); Undo says that it
 * goes back on the calendar and that money is not moved.
 */
function NoShowFooter({
  detail,
  kind,
  error,
  busy,
  onKeep,
  onConfirm,
}: {
  detail: AppointmentDetail;
  kind: "mark" | "undo";
  error: string | null;
  busy: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const fee = detail.noShowFee ?? null;
  const feeText = fee
    ? `${fee.cents % 100 === 0 ? `$${fee.cents / 100}` : `$${(fee.cents / 100).toFixed(2)}`}`
    : null;
  // Why nothing is charged, in the server's terms (config/shopPolicy.ts).
  const none = detail.noShowCard && !detail.noShowCard.charge ? detail.noShowCard : null;
  return (
    <div className="flex w-full flex-col gap-2" data-testid="no-show-confirm">
      <p className="text-sm font-medium text-offwhite">
        {kind === "mark" ? "Mark this a no-show?" : "Undo this no-show?"}
      </p>
      <p className="text-xs leading-relaxed text-muted">
        {kind === "mark"
          ? feeText
            ? `The card ${fee?.last4 ? `ending ${fee.last4} ` : ""}kept for this booking is charged the ${feeText} no-show fee now. If you mark it by mistake, you can undo it, but the fee is not refunded automatically.`
            : none
              ? `${describeNoShowCardOutcome(none).text} You can undo it afterwards if you mark it by mistake.`
              : "No fee is charged. You can undo it afterwards if you mark it by mistake."
          : "It goes back on your calendar as booked, if the time is still free. No money is charged or refunded."}
      </p>
      {kind === "mark" && none && describeNoShowCardOutcome(none).settingsLink && <FeeSettingsLink />}
      {error && (
        <p role="alert" data-testid="no-show-error" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
        >
          Keep it
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={cn(
            "flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl px-4 text-sm font-medium transition-colors duration-150 ease-out disabled:opacity-50",
            kind === "mark"
              ? "border border-danger-soft/50 text-danger-soft hover:bg-danger-soft/10"
              : "border border-emerald-soft/45 text-emerald-soft hover:bg-emerald-soft/10",
          )}
        >
          {busy ? "Saving…" : kind === "mark" ? "Mark no-show" : "Undo no-show"}
        </button>
      </div>
    </div>
  );
}

/**
 * "Didn't show up? Mark no-show" on Checkout - with what it does to the card
 * said BEFORE the tap: the server's figure and card, or the one reason nothing
 * is charged. Tapping opens the same confirm the More menu does.
 */
function CheckoutNoShowRow({
  outcome,
  onMark,
}: {
  outcome: NoShowCardOutcome;
  onMark: () => void;
}) {
  const said = describeNoShowCardOutcome(outcome);
  return (
    <div className="flex flex-col gap-1.5" data-testid="checkout-no-show">
      <button
        type="button"
        onClick={onMark}
        data-qa="checkout-no-show"
        className="flex min-h-[2.75rem] w-full items-start gap-3 rounded-lg border border-danger-soft/40 px-3.5 py-3 text-left transition-colors duration-150 ease-out hover:bg-danger-soft/10"
      >
        <span className="mt-0.5 shrink-0 text-danger-soft" aria-hidden="true">
          <EmptyChairIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-offwhite">
            Didn&rsquo;t show up? <span className="text-danger-soft">Mark no-show</span>
          </span>
          <span
            className={cn(
              "mt-0.5 block text-xs leading-relaxed [overflow-wrap:anywhere]",
              outcome.charge ? "text-offwhite" : "text-muted",
            )}
            data-testid="checkout-no-show-card"
          >
            {said.text}
          </span>
        </span>
      </button>
      {said.settingsLink && <FeeSettingsLink />}
    </div>
  );
}

/** Where no-show fees are switched on and set (Payments, How customers pay). */
function FeeSettingsLink() {
  return (
    <Link
      href="/dashboard/payments#no-show-fees"
      data-testid="no-show-fee-settings"
      className="self-start px-1 text-xs font-medium text-gold underline underline-offset-2"
    >
      Turn on and set no-show fees
    </Link>
  );
}

/** After an undo that left something as it was: the server's own sentences. */
function UndoneNoShowFooter({ notes, onDone }: { notes: string[]; onDone: () => void }) {
  return (
    <div className="flex w-full flex-col gap-2" data-testid="no-show-undone">
      <p role="status" className="text-sm font-medium text-emerald-soft">
        Back on the calendar.
      </p>
      <ul className="flex flex-col gap-1">
        {notes.map((n) => (
          <li key={n} className="text-xs leading-relaxed text-warning-soft">
            {n}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDone}
        className="flex h-11 w-full items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        Done
      </button>
    </div>
  );
}

/**
 * After Mark no-show: what the kept card actually did, in words - charged,
 * declined (and why, in the bank's terms), a payment setup problem on
 * ChairBack's side, or nothing - and waits for Done.
 */
function MarkedNoShowFooter({
  kind,
  result,
  last4,
  onDone,
}: {
  kind: "no_show" | "late_cancel" | "approved_fee";
  result: NoShowChargeResult;
  last4: string | null;
  onDone: () => void;
}) {
  const said =
    kind !== "no_show" ? describeLateCancelChargeResult(result, last4) : describeNoShowChargeResult(result, last4);
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid={
        kind === "late_cancel" ? "late-cancel-done" : kind === "approved_fee" ? "card-fee-decided" : "no-show-marked"
      }
    >
      <p role="status" className="text-sm font-medium text-offwhite">
        {kind === "late_cancel"
          ? "Cancelled as a late cancel."
          : kind === "approved_fee"
            ? "Late-cancel fee approved."
            : "Marked no-show."}
      </p>
      <p
        className={cn(
          "text-xs leading-relaxed",
          said.tone === "good" ? "text-emerald-soft" : said.tone === "warn" ? "text-warning-soft" : "text-muted",
        )}
      >
        {said.text}
      </p>
      <button
        type="button"
        onClick={onDone}
        className="flex h-11 w-full items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        Done
      </button>
    </div>
  );
}

/** Whether two instants fall on the same calendar day in the shop's zone. */
function sameShopDay(aIso: string, bIso: string, zone: string): boolean {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" });
    return f.format(new Date(aIso)) === f.format(new Date(bIso));
  } catch {
    return false;
  }
}

/**
 * The detail view's footer is deliberately QUIET: the sheet's one solid-brass
 * action is Start checkout, and it lives in the payment card next to the
 * number it acts on. A second bright button here would compete with it.
 */
function DetailFooter({
  detail,
  notice,
  onEdit,
}: {
  detail: AppointmentDetail | null;
  /** What the last save said - see SavedNotice. Sits where Save just was. */
  notice: SavedNotice | null;
  onEdit: () => void;
}) {
  if (!detail) return null;
  if (detail.editable) {
    return (
      // `sm:items-start` keeps the button its own width once the footer is a
      // row, exactly as it was before the notice had somewhere to go.
      <div className="flex w-full flex-col gap-2 sm:items-start">
        {notice && (
          <p
            role="status"
            className={cn(
              "text-sm",
              notice.tone === "success" ? "text-emerald-soft" : "text-warning-soft",
            )}
          >
            {notice.message}
          </p>
        )}
        <button
          type="button"
          onClick={onEdit}
          data-qa="edit-appointment"
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite sm:w-auto sm:px-6"
        >
          <PencilIcon />
          Edit appointment
        </button>
      </div>
    );
  }
  // Read-only, and it says WHY rather than leaving a dead sheet: a booking
  // another system owns is changed there, and this card mirrors it.
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {/* A closed booking still has one money action - Refund deposit - and
            its outcome lands here, where it outlives the panel it came from. */}
        {notice && (
          <p
            role="status"
            data-qa="sheet-notice"
            className={cn(
              "text-sm",
              notice.tone === "success" ? "text-emerald-soft" : "text-warning-soft",
            )}
          >
            {notice.message}
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-muted">
          {detail.readOnlyReason === "external"
            ? `Booked in ${detail.originLabel}. Change or cancel it there — this sheet mirrors it so the time stays blocked here.`
            : "This booking is closed, so it can no longer be edited."}
        </p>
      </div>
      {detail.externalManageUrl && (
        <a
          href={detail.externalManageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 shrink-0 items-center justify-center rounded-xl border border-info-soft/40 px-4 text-sm font-medium text-info-soft transition-colors duration-150 ease-out hover:bg-info-soft/10"
        >
          Edit in {detail.originLabel}
        </a>
      )}
    </div>
  );
}

/**
 * Save is live only once something has changed, and a refusal is read HERE,
 * directly above it - the same rule as FormFooter. A toast draws beneath the
 * dialog, so on a phone the refusals were invisible and Save looked broken.
 */
function EditFooter({
  pending,
  disabled,
  error,
  onCancel,
  onSave,
}: {
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      <TwoUp
        secondary={{ label: "Cancel", onClick: onCancel, disabled: pending }}
        primary={{
          label: pending ? "Saving…" : "Save changes",
          onClick: onSave,
          disabled: pending || disabled,
        }}
      />
    </div>
  );
}

/**
 * What the checkout footer says when the save is refused, by the reason the
 * API gave. Always ends by saying nothing was recorded, so the barber knows
 * it is safe to try again. The reason code is shown for anything unexpected,
 * so a screenshot tells us what happened.
 */
function checkoutFailureCopy(code: string | undefined): string {
  switch (code) {
    case "network_error":
      return "Couldn't reach ChairBack. Check your signal and try again. Nothing was recorded.";
    case "collection_in_progress":
      return "A card payment is still being confirmed. Nothing was recorded.";
    case "not_found":
      return "This appointment can't be checked out - it may have been canceled. Nothing was recorded.";
    case "invalid_input":
      return "That amount or payment type wasn't accepted. Check the amount and try again. Nothing was recorded.";
    default:
      return `Couldn't save the checkout${code ? ` (${code})` : ""}. Nothing was recorded. Try again.`;
  }
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

type FeeDecisionProps = {
  onDecide: (decision: "charge" | "waive") => void;
  busy: boolean;
  error: string | null;
};

/**
 * "Charge $25 or waive it?" - a client's late-cancel fee waiting for the
 * barber (Shop.cardFeeNeedsApproval). The figure is the server's, fixed when
 * the client cancelled; nothing here types or recomputes it. Its outcome is
 * said in the footer (a toast is invisible under this dialog on a phone).
 */
function CardFeeApproval({
  waiting,
  timezone,
  onDecide,
  busy,
  error,
}: {
  waiting: NonNullable<AppointmentDetail["cardFeeAwaiting"]> | null;
  timezone: string;
} & FeeDecisionProps) {
  let lapses = "";
  if (waiting) {
    try {
      lapses = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        month: "short",
        day: "numeric",
      }).format(new Date(waiting.lapsesAt));
    } catch {
      lapses = "";
    }
  }
  return (
    <div
      className="mt-3.5 flex flex-col gap-2 border-t border-subtle pt-3.5"
      data-testid="card-fee-approval"
    >
      {waiting && (
        <>
          <p className="text-sm font-medium text-offwhite">
            {`Charge the ${money(waiting.cents)} late-cancel fee?`}
          </p>
          <p className="text-xs leading-relaxed text-muted">
            The client cancelled inside your cutoff. Nothing has been charged.{" "}
            {waiting.last4 ? `Charge goes on the card ending ${waiting.last4}.` : "Charge goes on the card they saved."}
            {lapses ? ` If you don't decide by ${lapses}, the card is let go uncharged.` : ""}
          </p>
        </>
      )}
      {error && (
        <p role="alert" data-testid="card-fee-approval-error" className="text-sm text-danger-soft">
          {error}
        </p>
      )}
      {waiting && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onDecide("waive")}
            disabled={busy}
            data-testid="card-fee-waive"
            className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-subtle px-4 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Waive it
          </button>
          <button
            type="button"
            onClick={() => onDecide("charge")}
            disabled={busy}
            data-testid="card-fee-charge"
            className="flex h-11 min-w-0 flex-1 shrink-0 items-center justify-center rounded-xl border border-danger-soft/50 px-4 text-sm font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
          >
            {busy ? "Saving…" : `Charge ${money(waiting.cents)}`}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A no-show / late-cancel fee on the card on file, as the barber's proof:
 * "Late-cancel fee · card ending 4242 · Oct 30, 2:15 PM   $15.00 charged".
 * Only "charged" means Stripe took the money.
 */
function CardFeeLine({
  fee,
  timezone,
}: {
  fee: NonNullable<AppointmentDetail["cardFee"]>;
  timezone: string;
}) {
  let when = "";
  try {
    when = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(fee.at));
  } catch {
    when = "";
  }
  const label = [
    fee.reason === "no_show" ? "No-show fee" : "Late-cancel fee",
    fee.last4 ? `card ending ${fee.last4}` : null,
    when || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const amount = money(fee.cents);
  const value =
    fee.state === "charged"
      ? `${amount} charged`
      : fee.state === "pending"
        ? `${amount} · waiting on Stripe`
        : fee.state === "declined"
          ? `${amount} declined`
          : fee.state === "refunded"
            ? `${amount} refunded`
            : `${amount} not charged`;
  return (
    <div data-testid="card-fee-line">
      <Line label={label} value={value} tone={fee.state === "charged" ? "good" : fee.state === "pending" ? undefined : "bad"} />
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
const TipIcon = () => (
  <Svg>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
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
