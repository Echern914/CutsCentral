"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSignalNativeReady } from "@/lib/nativeReady";
import {
  kioskChallengeAction,
  kioskCheckInAction,
  kioskDeskWaitsAction,
  kioskEstimateAction,
  kioskResolveAction,
  kioskVerifyAction,
  type KioskMenu,
  type KioskShopData,
} from "./actions";

/**
 * The kiosk flow, one component, one in-memory state machine.
 *
 * 🔴 SHARED-DEVICE PRIVACY IS THE DESIGN CONSTRAINT. Nothing a customer
 * types is ever persisted: no localStorage, no sessionStorage, no cookies,
 * no per-step history entries (Back leaves the page, it cannot page back
 * through someone's phone number), autocomplete is off everywhere, and
 * `reset()` wipes every field on success, cancel, error-recovery and after
 * IDLE_MS of inactivity. The only thing that survives a reset is the kiosk
 * credential itself (the shop's, not a customer's), read once from the URL
 * fragment.
 *
 * The screens deliberately show nothing the API didn't just say: eligibility,
 * estimates and dedupe answers are all server truths - this component is a
 * remote control, not a second implementation.
 *
 * A TEAM FRONT DESK (a booth-rent shop whose independent barbers take its
 * walk-ins) adds one step after the name: "Who are you here for?" - each
 * business with its wait, or "Next available". Everything after it is that
 * business's own menu and line; the server re-checks the pick at check-in.
 */

type Step =
  | "loading"
  | "bad_link"
  | "closed"
  | "not_ready"
  | "welcome"
  | "phone"
  | "code"
  | "identity"
  | "who"
  | "services"
  | "barber"
  | "review"
  | "done"
  | "offline";

/** Idle on any mid-flow step this long -> wipe and return to welcome. */
const IDLE_MS = 90_000;
/** The success screen lingers this long, then resets for the next customer. */
const DONE_MS = 12_000;
const MAX_SERVICES = 3;

/** Kiosk-scale controls: comfortably past the 44px floor, 16px+ text. */
const BTN =
  "flex min-h-14 w-full items-center justify-center rounded-2xl px-6 text-lg font-semibold transition-colors disabled:opacity-40";
const PRIMARY = `${BTN} bg-gold text-charcoal hover:bg-gold-muted`;
const GHOST = `${BTN} border border-subtle bg-charcoal-800/60 text-offwhite hover:bg-charcoal-700`;
const INPUT =
  "h-14 w-full min-w-0 rounded-2xl border border-subtle bg-charcoal-900 px-4 text-center text-2xl text-offwhite outline-none focus:border-gold";

function digitsOnly(v: string): string {
  return v.replace(/\D/g, "").slice(0, 15);
}

export function prettyPhone(raw: string): string {
  // A leading US "1" is the country code, not part of the number; it used to
  // shift every digit and hide the last one.
  const d = raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw;
  if (d.length > 10) return raw; // never hide a typed digit
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function KioskClient() {
  useSignalNativeReady();

  const [kioskToken, setKioskToken] = useState<string | null>(null);
  const [data, setData] = useState<KioskShopData | null>(null);
  const [step, setStep] = useState<Step>("loading");

  // Per-customer state - everything reset() clears.
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [proof, setProof] = useState<string | null>(null);
  const [knownFirstName, setKnownFirstName] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [preferredStaffId, setPreferredStaffId] = useState<string | null>(null);
  // 🔴 MUST start unticked, for every customer: a pre-ticked box is not
  // consent (the booking page has the same rule).
  const [smsConsent, setSmsConsent] = useState(false);
  const [estimate, setEstimate] = useState<{
    waitMin: number | null;
    ahead: number;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Team front desk: who they picked, and each business's wait as last read.
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [waits, setWaits] = useState<Map<string, number | null> | null>(null);

  const reset = useCallback(() => {
    setPhone("");
    setCode("");
    setProof(null);
    setKnownFirstName(null);
    setFirstName("");
    setLastName("");
    setServiceIds([]);
    setPreferredStaffId(null);
    setBusinessId(null);
    setWaits(null);
    setSmsConsent(false);
    setEstimate(null);
    setPending(false);
    setFlash(null);
    setStep("welcome");
  }, []);

  // The kiosk credential: URL fragment, read once, kept in memory only. The
  // fragment is deliberately NOT stripped - it is the SHOP's credential on
  // the SHOP's device, and stripping it would break the tablet's bookmark.
  useEffect(() => {
    const m = /[#&]k=([^&]+)/.exec(window.location.hash);
    if (!m) {
      setStep("bad_link");
      return;
    }
    setKioskToken(m[1]!);
  }, []);

  const load = useCallback(async () => {
    if (!kioskToken) return;
    const res = await kioskResolveAction(kioskToken);
    if (!res.ok || !res.data) {
      setStep((s) => (s === "loading" ? "bad_link" : "offline"));
      return;
    }
    setData(res.data);
    setStep((s) => {
      // Checked BEFORE "paused": a shop with nothing to book was never open in
      // the first place, and `walkInAcceptingNow` defaults to true, so an
      // unfinished shop would otherwise read as deliberately closed.
      if (!res.data!.setupComplete) return "not_ready";
      if (!res.data!.acceptingNow) return "closed";
      // A reopened - or newly finished - shop recovers on the next load; mid-flow
      // steps are preserved.
      return s === "loading" || s === "closed" || s === "not_ready" ? "welcome" : s;
    });
  }, [kioskToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // Idle wipe: any interaction bumps the timer; expiry wipes the customer.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      reset();
    }, IDLE_MS);
  }, [reset]);
  useEffect(() => {
    const midFlow = !["loading", "bad_link", "closed", "welcome"].includes(step);
    if (!midFlow) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      return;
    }
    bumpIdle();
    const bump = () => bumpIdle();
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [step, bumpIdle]);

  // Success lingers briefly, then wipes for the next customer.
  useEffect(() => {
    if (step !== "done") return;
    const t = setTimeout(() => reset(), DONE_MS);
    return () => clearTimeout(t);
  }, [step, reset]);

  const accent = data?.shop.accentColor ?? undefined;

  const desk = data?.desk ?? null;
  const business = desk?.businesses.find((b) => b.id === businessId) ?? null;
  /** The menu the customer is choosing from: the business they picked at a desk. */
  const menu: KioskMenu | null = desk ? business : data;

  const eligibleStaff = useMemo(() => {
    if (!menu) return [];
    if (serviceIds.length === 0) return menu.staff;
    const offers = new Set(
      menu.offerings.map((o) => `${o.serviceId}:${o.staffId}`),
    );
    return menu.staff.filter((s) =>
      serviceIds.every((svc) => offers.has(`${svc}:${s.id}`)),
    );
  }, [menu, serviceIds]);
  // Changing services can leave the chosen barber off the list - kept, they
  // were sent to a barber who doesn't do what the customer now wants.
  useEffect(() => {
    if (preferredStaffId && !eligibleStaff.some((s) => s.id === preferredStaffId)) {
      setPreferredStaffId(null);
    }
  }, [eligibleStaff, preferredStaffId]);

  // ---- step actions -------------------------------------------------------

  /**
   * After the name: a front desk asks who they're here for (with fresh
   * waits); a single shop goes straight to its services.
   */
  const afterName = useCallback(async () => {
    if (!desk || !kioskToken) {
      setStep("services");
      return;
    }
    setStep("who");
    const res = await kioskDeskWaitsAction(kioskToken);
    // Waits are a courtesy: without them every business is still a choice.
    setWaits(res.ok && res.data ? new Map(res.data.businesses.map((b) => [b.id, b.waitMin])) : new Map());
  }, [desk, kioskToken]);

  const pickBusiness = useCallback((id: string) => {
    setBusinessId(id);
    setServiceIds([]);
    setPreferredStaffId(null);
    setStep("services");
  }, []);

  const sendCode = useCallback(async () => {
    if (!kioskToken || pending) return;
    setPending(true);
    setFlash(null);
    const res = await kioskChallengeAction({
      token: kioskToken,
      phone: digitsOnly(phone),
    });
    setPending(false);
    if (res.status === 400) {
      setFlash("That doesn't look like a mobile number - check it and try again.");
      return;
    }
    // Walk-ins paused (texting off, or the shop stopped taking them): say so,
    // not "couldn't reach the shop's system".
    if (res.error === "not_accepting") {
      setStep("closed");
      return;
    }
    if (!res.ok) {
      setStep("offline");
      return;
    }
    setCode("");
    setStep("code");
  }, [kioskToken, phone, pending]);

  const verifyCode = useCallback(async () => {
    if (!kioskToken || pending) return;
    setPending(true);
    setFlash(null);
    const res = await kioskVerifyAction({
      token: kioskToken,
      phone: digitsOnly(phone),
      code,
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setStep("offline");
      return;
    }
    if (!res.data.verified || !res.data.proof) {
      setCode("");
      setFlash("That code didn't work. Check the text or resend a new code.");
      return;
    }
    setProof(res.data.proof);
    if (res.data.known && res.data.firstName) {
      setKnownFirstName(res.data.firstName);
      setFirstName(res.data.firstName);
      void afterName();
    } else {
      setStep("identity");
    }
  }, [kioskToken, phone, code, pending, afterName]);

  const toReview = useCallback(async () => {
    if (!kioskToken || pending) return;
    setPending(true);
    const res = await kioskEstimateAction({
      token: kioskToken,
      serviceIds,
      preferredStaffId,
      ...(desk ? { businessId } : {}),
    });
    setPending(false);
    // The estimate is a courtesy, not a gate - review still renders with
    // honest "estimate unavailable" copy when the call fails.
    setEstimate(res.ok && res.data ? { waitMin: res.data.waitMin, ahead: res.data.ahead } : null);
    setStep("review");
  }, [kioskToken, serviceIds, preferredStaffId, pending, desk, businessId]);

  const submit = useCallback(async () => {
    if (!kioskToken || !proof || pending) return;
    setPending(true);
    setFlash(null);
    const res = await kioskCheckInAction({
      token: kioskToken,
      proof,
      phone: digitsOnly(phone),
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      serviceIds,
      preferredStaffId,
      smsConsent,
      ...(desk ? { businessId } : {}),
    });
    setPending(false);
    if (res.ok) {
      setStep("done");
      return;
    }
    if (desk && res.error === "invalid_selection") {
      // Who they picked just stopped taking walk-ins (or changed their menu).
      // Their verified number still stands: pick again from a fresh list.
      setFlash("That barber can't take walk-ins right now - please pick again.");
      setBusinessId(null);
      setServiceIds([]);
      setPreferredStaffId(null);
      await load();
      await afterName();
      return;
    }
    if (res.error === "queue_full") {
      setFlash("The line is full right now - please check with the front desk.");
      return;
    }
    if (res.error === "not_accepting") {
      setStep("closed");
      return;
    }
    if (res.error === "verification_required") {
      // The proof aged out while they browsed - one fresh code, no data loss.
      setProof(null);
      setCode("");
      setFlash("That took a little while - we'll text you a fresh code.");
      setStep("phone");
      return;
    }
    setStep("offline");
  }, [
    kioskToken,
    proof,
    phone,
    firstName,
    lastName,
    serviceIds,
    preferredStaffId,
    smsConsent,
    pending,
    desk,
    businessId,
    load,
    afterName,
  ]);

  // ---- screens ------------------------------------------------------------

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 overflow-x-hidden px-6 py-10 text-offwhite">
      {data ? (
        <header className="flex items-center justify-center gap-3">
          {data.shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.shop.logoUrl}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : null}
          <span className="text-lg font-semibold">{data.shop.name}</span>
        </header>
      ) : null}
      {children}
      {flash ? (
        <p role="alert" className="text-center text-base text-danger-soft">
          {flash}
        </p>
      ) : null}
    </main>
  );

  if (step === "loading") {
    return shell(<p className="text-center text-muted">One moment…</p>);
  }
  if (step === "bad_link") {
    return shell(
      <p className="text-center text-lg text-muted">
        This check-in screen isn't set up. Please see the front desk.
      </p>,
    );
  }
  if (step === "offline") {
    return shell(
      <>
        <p className="text-center text-lg">
          We couldn't reach the shop's system. Nothing was lost - please see
          the front desk, or try again.
        </p>
        <button type="button" className={PRIMARY} style={accent ? { backgroundColor: accent } : undefined} onClick={() => void load().then(() => reset())}>
          Try again
        </button>
      </>,
    );
  }
  if (step === "closed") {
    return shell(
      <p className="text-center text-2xl font-semibold">
        Walk-ins are paused right now - please check with the front desk.
      </p>,
    );
  }
  if (step === "not_ready") {
    // Two audiences, one screen. The customer needs to know not to stand there
    // tapping; whoever set the tablet up needs to know WHICH thing is missing,
    // in their own words. Naming it is the difference between "the app is
    // broken" and a thirty-second fix.
    if (desk) {
      return shell(
        <>
          <p className="text-center text-2xl font-semibold">
            No one is taking walk-ins here right now - please check with the front desk.
          </p>
          <p className="text-center text-muted">
            Staff: each barber turns on front-desk walk-ins on their Teams page, with their own
            walk-in line switched on and at least one service.
          </p>
        </>,
      );
    }
    const missing =
      data && data.services.length === 0 && data.staff.length === 0
        ? "no services or barbers"
        : data && data.services.length === 0
          ? "no services"
          : "no barbers";
    return shell(
      <>
        <p className="text-center text-2xl font-semibold">
          This shop hasn&apos;t finished setting up - please check with the front desk.
        </p>
        <p className="text-center text-muted">
          Staff: walk-in check-in needs at least one active service and one active
          barber. This shop has {missing} set up yet.
        </p>
      </>,
    );
  }
  if (step === "welcome") {
    return shell(
      <>
        <h1 className="text-center text-3xl font-bold">Walk right in.</h1>
        <p className="text-center text-lg text-muted">
          Check in here and we'll text you your place in line - no app needed.
        </p>
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          onClick={() => {
            reset();
            setStep("phone");
          }}
        >
          Check in
        </button>
        <p className="text-center text-sm text-muted">
          First time or a regular - same three taps.
        </p>
      </>,
    );
  }
  if (step === "phone") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">
          What's your mobile number?
        </h2>
        <p className="text-center text-muted">
          We'll text a 6-digit code to make sure it's yours.
        </p>
        <input
          className={INPUT}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          aria-label="Mobile number"
          placeholder="(555) 555-1234"
          value={prettyPhone(digitsOnly(phone))}
          onChange={(e) => setPhone(digitsOnly(e.target.value))}
        />
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={digitsOnly(phone).length < 10 || pending}
          onClick={() => void sendCode()}
        >
          {pending ? "Sending…" : "Text me a code"}
        </button>
        <button type="button" className={GHOST} onClick={reset}>
          Start over
        </button>
      </>,
    );
  }
  if (step === "code") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">Enter your code</h2>
        <p className="text-center text-muted">
          We texted 6 digits to {prettyPhone(digitsOnly(phone))}.
        </p>
        <input
          className={`${INPUT} tracking-[0.5em]`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit verification code"
          placeholder="••••••"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={code.length !== 6 || pending}
          onClick={() => void verifyCode()}
        >
          {pending ? "Checking…" : "Verify"}
        </button>
        <div className="flex gap-3">
          <button type="button" className={GHOST} disabled={pending} onClick={() => void sendCode()}>
            Resend code
          </button>
          <button type="button" className={GHOST} onClick={reset}>
            Start over
          </button>
        </div>
      </>,
    );
  }
  if (step === "identity") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">
          What should we call you?
        </h2>
        <input
          className={`${INPUT} text-left`}
          type="text"
          autoComplete="off"
          aria-label="First name"
          placeholder="First name"
          maxLength={80}
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          className={`${INPUT} text-left`}
          type="text"
          autoComplete="off"
          aria-label="Last name (optional)"
          placeholder="Last name (optional)"
          maxLength={80}
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={firstName.trim().length === 0}
          onClick={() => void afterName()}
        >
          Next
        </button>
        <button type="button" className={GHOST} onClick={reset}>
          Start over
        </button>
      </>,
    );
  }
  if (step === "who") {
    // Who can take them, soonest first is the customer's call - "Next
    // available" is simply the shortest wait we know of right now.
    const businesses = desk?.businesses ?? [];
    const waitOf = (id: string) => waits?.get(id);
    const soonest = waits
      ? businesses
          .filter((b) => typeof waitOf(b.id) === "number")
          .sort((a, b) => (waitOf(a.id) as number) - (waitOf(b.id) as number))[0]
      : undefined;
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">
          {knownFirstName ? `Welcome back, ${knownFirstName}!` : "Who are you here for?"}
        </h2>
        {knownFirstName ? <p className="text-center text-muted">Who are you here for today?</p> : null}
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={!soonest}
          onClick={() => soonest && pickBusiness(soonest.id)}
          data-qa="desk-next-available"
        >
          {waits === null
            ? "Checking waits…"
            : soonest
              ? `Next available - ${soonest.name}`
              : "No one can take a walk-in right now"}
        </button>
        <ul className="flex flex-col gap-3" data-qa="desk-businesses">
          {businesses.map((b) => {
            const wait = waitOf(b.id);
            const open = waits === null || typeof wait === "number";
            return (
              <li key={b.id}>
                <button
                  type="button"
                  disabled={!open}
                  className={`${BTN} justify-between border border-subtle bg-charcoal-800/60 text-offwhite`}
                  onClick={() => pickBusiness(b.id)}
                >
                  <span className="min-w-0 truncate">{b.name}</span>
                  <span className="ml-3 shrink-0 text-base text-muted">
                    {waits === null
                      ? ""
                      : typeof wait === "number"
                        ? wait === 0
                          ? "No wait"
                          : `About ${wait} min`
                        : "Not today"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className={GHOST} onClick={reset}>
          Start over
        </button>
      </>,
    );
  }
  if (step === "services") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">
          {knownFirstName && !desk ? `Welcome back, ${knownFirstName}!` : "What are you here for?"}
        </h2>
        {knownFirstName && !desk ? (
          <p className="text-center text-muted">What are you here for today?</p>
        ) : null}
        {business ? <p className="text-center text-muted">With {business.name}</p> : null}
        <ul className="flex flex-col gap-3">
          {(menu?.services ?? []).map((s) => {
            const on = serviceIds.includes(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  className={`${BTN} justify-between border ${
                    on
                      ? "border-gold bg-gold/15 text-gold"
                      : "border-subtle bg-charcoal-800/60 text-offwhite"
                  }`}
                  onClick={() =>
                    setServiceIds((ids) =>
                      on
                        ? ids.filter((x) => x !== s.id)
                        : ids.length >= MAX_SERVICES
                          ? ids
                          : [...ids, s.id],
                    )
                  }
                >
                  <span className="truncate">{s.name}</span>
                  <span className="ml-3 shrink-0 text-base text-muted">
                    {s.durationMin} min{s.price !== null ? ` · $${s.price}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={serviceIds.length === 0 || pending}
          onClick={() =>
            // One chair at a business: nobody to choose between.
            desk && (menu?.staff.length ?? 0) <= 1 ? void toReview() : setStep("barber")
          }
        >
          {pending ? "One sec…" : "Next"}
        </button>
        {desk ? (
          <button type="button" className={GHOST} onClick={() => void afterName()}>
            Pick someone else
          </button>
        ) : null}
        <button type="button" className={GHOST} onClick={reset}>
          Start over
        </button>
      </>,
    );
  }
  if (step === "barber") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">Anyone in particular?</h2>
        <ul className="flex flex-col gap-3">
          <li>
            <button
              type="button"
              aria-pressed={preferredStaffId === null}
              className={`${BTN} border ${
                preferredStaffId === null
                  ? "border-gold bg-gold/15 text-gold"
                  : "border-subtle bg-charcoal-800/60 text-offwhite"
              }`}
              onClick={() => setPreferredStaffId(null)}
            >
              Next available
            </button>
          </li>
          {eligibleStaff.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={preferredStaffId === s.id}
                className={`${BTN} border ${
                  preferredStaffId === s.id
                    ? "border-gold bg-gold/15 text-gold"
                    : "border-subtle bg-charcoal-800/60 text-offwhite"
                }`}
                onClick={() => setPreferredStaffId(s.id)}
              >
                <span className="truncate">{s.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={pending}
          onClick={() => void toReview()}
        >
          {pending ? "One sec…" : "See my wait"}
        </button>
        <button type="button" className={GHOST} disabled={pending} onClick={reset}>
          Start over
        </button>
      </>,
    );
  }
  if (step === "review") {
    const svc = (menu?.services ?? []).filter((s) => serviceIds.includes(s.id));
    const chair =
      preferredStaffId === null ? null : (menu?.staff.find((s) => s.id === preferredStaffId)?.name ?? null);
    // At a desk they picked a business; a chair inside it only if it has several.
    const barber = business
      ? chair && business.staff.length > 1
        ? `${business.name} · ${chair}`
        : business.name
      : (chair ?? "Next available");
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">Look right?</h2>
        <div className="rounded-2xl border border-subtle bg-charcoal-800/40 p-5 text-lg">
          <p className="truncate font-semibold">{firstName.trim()}</p>
          <p className="text-muted">{svc.map((s) => s.name).join(" + ")}</p>
          <p className="text-muted">With: {barber}</p>
          <p className="mt-3 text-xl">
            {estimate && estimate.waitMin !== null ? (
              <>
                Estimated wait about <strong>{estimate.waitMin} min</strong>
                {estimate.ahead > 0
                  ? ` · ${estimate.ahead} ahead of you`
                  : " · you're first in line"}
              </>
            ) : (
              "We can't estimate the wait right now - the shop will call you up in order."
            )}
          </p>
          <p className="mt-1 text-sm text-muted">
            Estimates change as the day moves - your text link stays current.
          </p>
        </div>
        <label className="flex min-h-11 items-start gap-3 text-sm text-muted">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={smsConsent}
            onChange={(e) => setSmsConsent(e.target.checked)}
          />
          <span>{data!.consent.text}</span>
        </label>
        <button
          type="button"
          className={PRIMARY}
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={pending}
          onClick={() => void submit()}
        >
          {pending ? "Joining…" : "Join the line"}
        </button>
        <div className="flex gap-3">
          <button type="button" className={`${GHOST} flex-1`} onClick={() => setStep("services")}>
            Go back
          </button>
          <button type="button" className={`${GHOST} flex-1`} disabled={pending} onClick={reset}>
            Start over
          </button>
        </div>
      </>,
    );
  }
  // done
  return shell(
    <>
      <h2 className="text-center text-3xl font-bold">You're in line! 🎉</h2>
      <p className="text-center text-lg text-muted">
        We texted your private link - watch your spot from your phone and
        we'll see you soon. This screen resets in a few seconds.
      </p>
      <button
        type="button"
        className={PRIMARY}
        style={accent ? { backgroundColor: accent } : undefined}
        onClick={reset}
      >
        Done
      </button>
    </>,
  );
}
