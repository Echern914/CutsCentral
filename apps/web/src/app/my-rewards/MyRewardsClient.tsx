"use client";

import { useEffect, useState } from "react";
import { useSignalNativeReady } from "@/lib/nativeReady";
import {
  recoveryChallengeAction,
  recoverySelectAction,
  recoveryShopsAction,
  recoveryVerifyAction,
  type RecoveryShop,
} from "./actions";

/**
 * The recovery flow, four screens: phone -> code -> choose your shop -> open.
 *
 * Copy discipline mirrors the API's constancy contract: the phone step always
 * says "if that number's on file we texted a code" - this page never knows,
 * and never implies, whether the number exists. The only branch a viewer can
 * observe happens AFTER they proved they hold the phone.
 */

type Step = "phone" | "code" | "choose" | "opening";

const INPUT =
  "w-full rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-3 text-base text-offwhite placeholder:text-muted";
const PRIMARY =
  "flex min-h-11 w-full items-center justify-center rounded-full bg-gold px-5 font-semibold text-charcoal-900 disabled:opacity-50";
const GHOST = "flex min-h-11 w-full items-center justify-center rounded-full text-muted";

export function MyRewardsClient() {
  useSignalNativeReady();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [proof, setProof] = useState<string | null>(null);
  const [shops, setShops] = useState<RecoveryShop[]>([]);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Client-side mirror of the server's 60s resend cooldown. The server is the
  // authority (it silently suppresses early resends); this exists so a
  // customer is never invited to tap a button that will quietly do nothing,
  // and so a double tap cannot fire two requests.
  const [cooldownLeft, setCooldownLeft] = useState(0);

  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const t = setInterval(() => setCooldownLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldownLeft > 0]);

  async function sendCode() {
    // In-flight and cooldown guards: a double tap or an early resend fires
    // exactly nothing. Sends happen ONLY here - never on mount, refresh or
    // step navigation.
    if (pending || cooldownLeft > 0) return;
    setPending(true);
    setFlash(null);
    const res = await recoveryChallengeAction(phone);
    setPending(false);
    if (!res.ok) {
      setFlash("Something went wrong. Please try again.");
      return;
    }
    setCooldownLeft(60);
    setCode("");
    setStep("code");
  }

  async function verify() {
    setPending(true);
    setFlash(null);
    const res = await recoveryVerifyAction(phone, code.trim());
    setPending(false);
    if (!res.ok || !res.data?.verified || !res.data.proof) {
      // Wrong, expired and never-sent are one message - this page knows no more
      // than the API admits.
      setFlash("That code didn't work. Check it, or send a fresh one.");
      return;
    }
    setPending(true);
    const list = await recoveryShopsAction(res.data.proof);
    setPending(false);
    if (!list.ok || !list.data) {
      setFlash("Something went wrong. Please try again.");
      return;
    }
    setProof(res.data.proof);
    setShops(list.data.shops);
    setStep("choose");
  }

  async function choose(selectionId: string) {
    if (!proof) return;
    setPending(true);
    setFlash(null);
    const res = await recoverySelectAction(proof, selectionId);
    setPending(false);
    if (!res.ok || !res.data?.url) {
      setFlash("Something went wrong. Please try again.");
      return;
    }
    setStep("opening");
    // A full navigation on purpose: the rewards URL may deep-link into the
    // native app, and only a real navigation lets the OS claim it.
    window.location.assign(res.data.url);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5 py-10">
      <h1 className="text-center text-2xl font-semibold text-offwhite">My rewards</h1>

      {step === "phone" && (
        <>
          <p className="text-center text-muted">
            Enter the mobile number your shop has for you and we&apos;ll text you a
            verification code.
          </p>
          <input
            className={INPUT}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555) 555-0134"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button
            type="button"
            className={PRIMARY}
            disabled={phone.trim().replace(/\D/g, "").length < 10 || pending}
            onClick={() => void sendCode()}
          >
            {pending ? "One sec…" : "Text me a code"}
          </button>
        </>
      )}

      {step === "code" && (
        <>
          <p className="text-center text-muted">
            If that number&apos;s on file, we just texted a 6-digit code. It expires in
            5 minutes.
          </p>
          <input
            className={`${INPUT} text-center tracking-[0.4em]`}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <button
            type="button"
            className={PRIMARY}
            disabled={code.length !== 6 || pending}
            onClick={() => void verify()}
          >
            {pending ? "Checking…" : "Verify"}
          </button>
          <button
            type="button"
            className={GHOST}
            disabled={pending || cooldownLeft > 0}
            onClick={() => void sendCode()}
          >
            {cooldownLeft > 0 ? `Send a fresh code (${cooldownLeft}s)` : "Send a fresh code"}
          </button>
        </>
      )}

      {step === "choose" &&
        (shops.length === 0 ? (
          // Verified, and no shop knows this number. The one honest empty state
          // in the flow - the viewer has proven they ARE the phone's owner.
          <p className="text-center text-muted">
            We couldn&apos;t find rewards for this number. If your shop uses
            ChairBack, ask them to add this number to your profile.
          </p>
        ) : (
          <>
            <p className="text-center text-muted">Choose your shop:</p>
            <ul className="flex flex-col gap-3">
              {shops.map((s) => (
                <li key={s.selectionId}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-3 rounded-2xl border border-subtle bg-charcoal-800/60 p-4 text-left"
                    disabled={pending}
                    onClick={() => void choose(s.selectionId)}
                  >
                    {s.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.logoUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-offwhite">{s.name}</span>
                      <span className="block truncate text-sm text-muted">
                        {[s.city, s.region].filter(Boolean).join(", ") || s.industry}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ))}

      {step === "opening" && <p className="text-center text-muted">Opening your rewards…</p>}

      {flash ? <p className="text-center text-sm text-muted">{flash}</p> : null}
    </main>
  );
}
