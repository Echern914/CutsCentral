import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiPublicGet } from "@/lib/api";
import { ReferralCodeForm } from "./ReferralCodeForm";

export const metadata: Metadata = { title: "Enter a referral code" };
export const dynamic = "force-dynamic";

/**
 * The cross-device half of attribution: someone saw a referral code on another
 * screen and is signing up here. Typing it mints exactly the claim the link
 * would have.
 *
 * The API's claim endpoint 404s while the program is dark, and so does this
 * page - the probe below is a plain liveness check that mints nothing and
 * counts nothing.
 */
export default async function JoinEnterPage() {
  const probe = await apiPublicGet<{ ok: boolean }>("/api/affiliate/claim");
  if (probe.status === 404) notFound();

  return (
    <main className="mx-auto w-full max-w-md px-5 py-12">
      <h1 className="mb-1 font-display text-3xl tracking-tight">
        Got a referral code?
      </h1>
      <p className="mb-6 text-sm text-muted">
        Enter it here and we&rsquo;ll credit whoever sent you. You can also skip
        this and{" "}
        <Link href="/signup" className="text-gold hover:underline">
          create your account
        </Link>{" "}
        without one.
      </p>
      <ReferralCodeForm />
    </main>
  );
}
