"use client";

import { useMemo, useRef, useState } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { Dialog } from "@/components/ui/Dialog";
import { copyText } from "@/lib/contactUri";
import { offerPrice, offerValueWords, type OfferKind } from "@chairback/config/offers";
import { normalizePromoCode } from "@chairback/config/promoPricing";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { chip, Field, FormFooter, Group, INPUT } from "../booking/formkit";
import { createOfferAction } from "./actions";

export interface OfferService {
  id: string;
  name: string;
  /** The menu price in dollars, or null when unpriced. */
  price: number | null;
}
export interface OfferStaff {
  id: string;
  name: string;
}

function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * MAKE AN OFFER - from Offers & codes, or from a client's page (then it is
 * theirs alone). The preview is worked out by the same functions the booking
 * charges with (@chairback/config/offers), so what it promises is what the
 * client pays.
 *
 * 🔴 Nothing is sent. The code is shown here for the shop to share itself,
 * and no consent is asked for or recorded.
 */
export function CreateOfferDialog({
  open,
  onClose,
  onCreated,
  services,
  staff,
  client,
  allowedServiceIds,
  ownStaffId,
  timezone,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  services: OfferService[];
  staff: OfferStaff[];
  /** Set: a personal offer for this client only. */
  client?: { id: string; name: string } | null;
  /** A provider seat's permitted services; null = any. */
  allowedServiceIds: string[] | null;
  ownStaffId: string | null;
  timezone: string;
}) {
  const vocab = useVocab();
  const choosable = useMemo(
    () => (allowedServiceIds ? services.filter((s) => allowedServiceIds.includes(s.id)) : services),
    [services, allowedServiceIds],
  );
  const [kind, setKind] = useState<OfferKind>(client ? "FREE_SERVICE" : "AMOUNT_OFF");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [freeServiceId, setFreeServiceId] = useState(choosable[0]?.id ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [staffIds, setStaffIds] = useState<string[]>(ownStaffId ? [ownStaffId] : []);
  const [code, setCode] = useState("");
  const [maxUses, setMaxUses] = useState(client ? "1" : "");
  const [perClient, setPerClient] = useState(client ? "" : "1");
  const [lastDay, setLastDay] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<{ code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);

  const amountCents = Math.round(Number(amount) * 100);
  const bps = Math.round(Number(percent) * 100);
  const valueProblem =
    kind === "AMOUNT_OFF"
      ? !(amount.trim() && Number.isFinite(amountCents) && amountCents >= 1 && amountCents <= 1_000_000)
        ? "Say how many dollars it takes off."
        : null
      : kind === "PERCENT_OFF"
        ? !(percent.trim() && Number.isFinite(bps) && bps >= 1 && bps <= 10_000)
          ? "Say what percent it takes off (up to 100)."
          : null
        : !freeServiceId
          ? `Pick the ${vocab.serviceNoun} it gives free.`
          : null;
  const mustPickServices = allowedServiceIds !== null && kind !== "FREE_SERVICE" && serviceIds.length === 0;
  const typedCode = code.trim() ? normalizePromoCode(code) : null;
  const codeProblem = code.trim() && !typedCode ? "Use 3 to 24 letters, numbers or dashes." : null;
  const endsAt = useMemo(() => {
    const [y, m, d] = lastDay.split("-").map(Number);
    if (!y || !m || !d) return null;
    // "Good through Oct 31": visits must START before Nov 1 at midnight.
    return zonedWallTimeToUtc(y, m - 1, d + 1, 0, timezone);
  }, [lastDay, timezone]);

  const terms = {
    kind,
    amountOffCents: kind === "AMOUNT_OFF" ? amountCents : null,
    percentOffBps: kind === "PERCENT_OFF" ? bps : null,
    freeServiceId: kind === "FREE_SERVICE" ? freeServiceId : null,
  };
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? null;
  const covered =
    kind === "FREE_SERVICE"
      ? choosable.filter((s) => s.id === freeServiceId)
      : serviceIds.length
        ? choosable.filter((s) => serviceIds.includes(s.id))
        : choosable;
  const previewLines = valueProblem
    ? []
    : covered
        .filter((s) => s.price !== null)
        .slice(0, 3)
        .map((s) => {
          const r = offerPrice(terms, { serviceCents: Math.round((s.price ?? 0) * 100), addOnCents: 0 });
          return `${s.name}: ${money(r.subtotalCents)} → pays ${money(r.totalCents)}`;
        });
  const who = client ? client.name : `Anyone with the code`;
  const withWho = staffIds.length
    ? `with ${staffIds.map((id) => staff.find((s) => s.id === id)?.name ?? cap(vocab.providerNoun)).join(" or ")}`
    : `with any ${vocab.providerNoun}`;
  const usesWords = client
    ? maxUses.trim() === "" || maxUses === "1"
      ? "One use."
      : `${maxUses} uses.`
    : `${maxUses.trim() ? `Up to ${maxUses} uses in total` : "No limit in total"}, ${perClient.trim() ? (perClient === "1" ? `once per ${vocab.clientNoun}` : `${perClient} per ${vocab.clientNoun}`) : `no limit per ${vocab.clientNoun}`}.`;
  const endWords = endsAt
    ? `Good for visits through ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${lastDay}T12:00:00Z`))}.`
    : "No end date.";

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submit() {
    if (inFlight.current) return;
    if (valueProblem || codeProblem || mustPickServices) {
      setError(valueProblem ?? codeProblem ?? `Pick the ${vocab.serviceNounPlural} it covers.`);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await createOfferAction({
        ...(typedCode ? { code: typedCode } : {}),
        kind,
        ...(kind === "AMOUNT_OFF" ? { amountOffCents: amountCents } : {}),
        ...(kind === "PERCENT_OFF" ? { percentOff: bps / 100 } : {}),
        ...(kind === "FREE_SERVICE" ? { freeServiceId } : { serviceIds }),
        staffIds,
        clientId: client?.id ?? null,
        maxUses: maxUses.trim() ? Number(maxUses) : null,
        maxUsesPerClient: client ? null : perClient.trim() ? Number(perClient) : null,
        endsAt: endsAt ? endsAt.toISOString() : null,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (res.ok) setMade({ code: res.code });
      else setError(res.error);
    } catch {
      setError("No answer from ChairBack. Check your connection, then look at your offers before making it again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const close = () => {
    if (made) onCreated();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={client ? `Offer for ${client.name}` : "Create offer"}
      footer={
        made ? (
          <button
            type="button"
            onClick={close}
            className="flex h-11 w-full items-center justify-center rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            Done
          </button>
        ) : (
          <FormFooter error={error} label="Create offer" pendingLabel="Creating…" pending={pending} onSubmit={() => void submit()} />
        )
      }
    >
      {made ? (
        <div className="flex min-w-0 flex-col gap-3" data-testid="offer-made">
          <p className="text-sm text-offwhite">Made. The code is</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 rounded-lg border border-gold/40 bg-gold/5 px-3 py-2.5 text-center font-mono text-lg tracking-wider text-gold [overflow-wrap:anywhere]">
              {made.code}
            </code>
            <button
              type="button"
              onClick={() => void copyText(made.code).then(setCopied)}
              className="h-11 shrink-0 rounded-lg border border-subtle px-3 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-sm text-muted">
            ChairBack doesn&apos;t send it. Share it {client ? `with ${client.name}` : "where you like"} yourself.
          </p>
          {client && (
            <p className="text-sm text-offwhite" data-testid="staff-applied-note">
              <span className="font-medium">Staff-applied.</span> It works only when you book {client.name}: Calendar →
              New appointment → pick {client.name} as the client → Offer → enter the code. It can&apos;t be used on the
              online booking page.
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4" data-testid="offer-form">
          <Group title="What it gives">
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["AMOUNT_OFF", "$ off"],
                  ["PERCENT_OFF", "% off"],
                  ["FREE_SERVICE", `Free ${vocab.serviceNoun}`],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={chip(kind === k)}>
                  {label}
                </button>
              ))}
            </div>
            {kind === "AMOUNT_OFF" && (
              <Field label="Dollars off">
                <input inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" />
              </Field>
            )}
            {kind === "PERCENT_OFF" && (
              <Field label="Percent off">
                <input inputMode="decimal" className={INPUT} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="20" />
              </Field>
            )}
            {kind === "FREE_SERVICE" && (
              <Field label={`Free ${vocab.serviceNoun}`}>
                <select className={INPUT} value={freeServiceId} onChange={(e) => setFreeServiceId(e.target.value)}>
                  {choosable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </Group>

          {kind !== "FREE_SERVICE" && (
            <Group title={`On which ${vocab.serviceNounPlural}`}>
              <div className="flex flex-wrap gap-2">
                {choosable.map((s) => (
                  <button key={s.id} type="button" aria-pressed={serviceIds.includes(s.id)} onClick={() => setServiceIds(toggle(serviceIds, s.id))} className={chip(serviceIds.includes(s.id))}>
                    {s.name}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted/80">
                {serviceIds.length || allowedServiceIds ? "Only these." : `None picked = any ${vocab.serviceNoun}.`} Add-ons are always full price.
              </p>
            </Group>
          )}

          {!ownStaffId && (
            <Group title={`With which ${vocab.providerNounPlural}`}>
              <div className="flex flex-wrap gap-2">
                {staff.map((s) => (
                  <button key={s.id} type="button" aria-pressed={staffIds.includes(s.id)} onClick={() => setStaffIds(toggle(staffIds, s.id))} className={chip(staffIds.includes(s.id))}>
                    {s.name}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted/80">{staffIds.length ? "Only these." : `None picked = any ${vocab.providerNoun}.`}</p>
            </Group>
          )}

          <Group title="Code and limits">
            <Field label="Code" hint={typedCode ? `Saved as ${typedCode}. Its letters don't change what it gives.` : "Leave blank and ChairBack makes one."}>
              <input className={INPUT} value={code} onChange={(e) => setCode(e.target.value)} placeholder="SPOOKY25" autoCapitalize="characters" />
            </Field>
            {client ? (
              <Field label="Times it can be used">
                <input inputMode="numeric" className={INPUT} value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ""))} />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Uses in total" hint="Blank = no limit.">
                  <input inputMode="numeric" className={INPUT} value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ""))} />
                </Field>
                <Field label={`Per ${vocab.clientNoun}`} hint="Blank = no limit.">
                  <input inputMode="numeric" className={INPUT} value={perClient} onChange={(e) => setPerClient(e.target.value.replace(/\D/g, ""))} />
                </Field>
              </div>
            )}
            <Field label="Last day for visits (optional)">
              <input type="date" className={INPUT} value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
            </Field>
            <Field label="Only you see this (optional)">
              <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Halloween regulars" />
            </Field>
          </Group>

          <section aria-label="What they get" data-testid="offer-preview" className="flex min-w-0 flex-col gap-1 rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-3">
            <p className="text-sm text-offwhite [overflow-wrap:anywhere]">
              <span className="font-medium">{who}</span> gets{" "}
              {valueProblem ? "…" : offerValueWords(terms, nameOf).replace(/^A /, "a ")} {withWho}.
            </p>
            {previewLines.map((l) => (
              <p key={l} className="text-sm tabular-nums text-offwhite [overflow-wrap:anywhere]">
                {l}
              </p>
            ))}
            <p className="text-[11px] leading-snug text-muted">
              {usesWords} {endWords}{" "}
              {client
                ? `Staff-applied: only when you book ${client.name} (New appointment → Offer). Not usable online.`
                : "Anyone who has the code can use it, online or when you book them."}{" "}
              ChairBack sends nothing.
            </p>
          </section>
        </div>
      )}
    </Dialog>
  );
}
