"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSignalNativeReady } from "@/lib/nativeReady";
import {
  kioskChallengeAction,
  kioskCheckInAction,
  kioskEstimateAction,
  kioskResolveAction,
  kioskVerifyAction,
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
 */

type Step =
  | "loading"
  | "bad_link"
  | "closed"
  | "welcome"
  | "phone"
  | "code"
  | "identity"
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

function prettyPhone(d: string): string {
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
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
  const [smsConsent, setSmsConsent] = useState(true);
  const [estimate, setEstimate] = useState<{
    waitMin: number | null;
    ahead: number;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhone("");
    setCode("");
    setProof(null);
    setKnownFirstName(null);
    setFirstName("");
    setLastName("");
    setServiceIds([]);
    setPreferredStaffId(null);
    setSmsConsent(true);
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
      if (!res.data!.acceptingNow) return "closed";
      // A reopened shop recovers from "closed"; mid-flow steps are preserved.
      return s === "loading" || s === "closed" ? "welcome" : s;
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

  const eligibleStaff = useMemo(() => {
    if (!data) return [];
    if (serviceIds.length === 0) return data.staff;
    const offers = new Set(
      data.offerings.map((o) => `${o.serviceId}:${o.staffId}`),
    );
    return data.staff.filter((s) =>
      serviceIds.every((svc) => offers.has(`${svc}:${s.id}`)),
    );
  }, [data, serviceIds]);

  // ---- step actions -------------------------------------------------------

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
      setStep("services");
    } else {
      setStep("identity");
    }
  }, [kioskToken, phone, code, pending]);

  const toReview = useCallback(async () => {
    if (!kioskToken || pending) return;
    setPending(true);
    const res = await kioskEstimateAction({
      token: kioskToken,
      serviceIds,
      preferredStaffId,
    });
    setPending(false);
    // The estimate is a courtesy, not a gate - review still renders with
    // honest "estimate unavailable" copy when the call fails.
    setEstimate(res.ok && res.data ? { waitMin: res.data.waitMin, ahead: res.data.ahead } : null);
    setStep("review");
  }, [kioskToken, serviceIds, preferredStaffId, pending]);

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
    });
    setPending(false);
    if (res.ok) {
      setStep("done");
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
          onClick={() => setStep("services")}
        >
          Next
        </button>
      </>,
    );
  }
  if (step === "services") {
    return shell(
      <>
        <h2 className="text-center text-2xl font-semibold">
          {knownFirstName ? `Welcome back, ${knownFirstName}!` : "What are you here for?"}
        </h2>
        {knownFirstName ? (
          <p className="text-center text-muted">What are you here for today?</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {data!.services.map((s) => {
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
          disabled={serviceIds.length === 0}
          onClick={() => setStep("barber")}
        >
          Next
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
      </>,
    );
  }
  if (step === "review") {
    const svc = data!.services.filter((s) => serviceIds.includes(s.id));
    const barber =
      preferredStaffId === null
        ? "Next available"
        : (data!.staff.find((s) => s.id === preferredStaffId)?.name ?? "Next available");
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
        <button type="button" className={GHOST} onClick={() => setStep("services")}>
          Go back
        </button>
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
