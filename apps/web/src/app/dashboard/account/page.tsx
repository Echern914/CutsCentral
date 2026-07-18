import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet, apiPublicGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { AccountCard } from "../_components/AccountCard";

export const metadata: Metadata = { title: "Account" };

/**
 * The barber's personal account page: profile (photo + name), sign-in methods,
 * password, login email, and the danger zone. Shop-level settings stay on the
 * Overview's SettingsCard - this page is about the PERSON, not the shop.
 */
export default async function AccountPage() {
  const me = await getMe();
  if (me.status === 401) redirect("/login");
  // A public read-only demo session shares ONE account - its email/password/
  // delete forms would only confuse (every mutation is refused server-side
  // anyway). Same gate as the card's old overview placement.
  if (me.data?.demo) redirect("/dashboard");

  const [shopRes, emailChange] = await Promise.all([
    // Only the name is needed (the delete-shop typed confirmation). A 404
    // (no shop yet / just deleted) simply hides that form.
    apiGet<{ name: string }>("/api/shops/me"),
    apiPublicGet<{ available: boolean }>("/api/auth/email-change/available"),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted">
          Your profile, how you sign in, and the buttons we hope you never need.
        </p>
      </header>
      <AccountCard
        name={me.data?.name ?? ""}
        email={me.data?.email ?? ""}
        avatarUrl={me.data?.avatarUrl ?? ""}
        shopName={shopRes.data?.name ?? ""}
        hasPassword={me.data?.hasPassword ?? true}
        hasGoogle={me.data?.hasGoogle ?? false}
        hasApple={me.data?.hasApple ?? false}
        emailChangeAvailable={emailChange.data?.available ?? false}
      />
    </main>
  );
}
