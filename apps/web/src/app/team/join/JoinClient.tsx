"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { joinTeamAction } from "./actions";

const ROLE_BLURB: Record<string, string> = {
  MANAGER: "You'll be able to run the shop day to day.",
  BARBER: "You'll be set up with your own chair.",
  OWNER: "",
};

/**
 * The confirm step. Everything that could go wrong (wrong address, expired,
 * already used) was already resolved server-side before this renders, so the
 * only job here is one deliberate tap — an invite should never be accepted by
 * a link preview fetching the page.
 */
export function JoinClient({
  token,
  shopName,
  role,
}: {
  token: string;
  shopName: string;
  role: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function accept() {
    setError(null);
    start(async () => {
      const res = await joinTeamAction(token);
      if (res.ok || res.error === "already_member") {
        // Already a member counts as success: they have the access the link
        // promised, which is all they came here for.
        router.push("/dashboard");
        router.refresh();
        return;
      }
      setError(
        res.error === "email_mismatch"
          ? "This invitation is for a different email address."
          : "This invitation is no longer valid. Ask for a new one.",
      );
    });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
      <h1 className="font-display text-2xl text-offwhite">Join {shopName}</h1>
      <p className="mt-2 text-sm text-muted">
        You&apos;ve been invited to {shopName} on ChairBack.{" "}
        {ROLE_BLURB[role] ?? ""}
      </p>
      <button
        onClick={accept}
        disabled={pending}
        className="mt-5 w-full rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
      >
        {pending ? "Joining…" : "Accept invitation"}
      </button>
      <FormError className="mt-3">{error}</FormError>
    </div>
  );
}
