import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet, apiPublicGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { AccountCard } from "../_components/AccountCard";
import { AppearanceCard } from "./AppearanceCard";
import { AdvancedCard, NotificationsCard } from "./NotificationsCard";
import type { NotificationsResponse } from "./types";

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

  const [shopRes, emailChange, notify] = await Promise.all([
    // Only the name is needed (the delete-shop typed confirmation). A 404
    // (no shop yet / just deleted) simply hides that form.
    apiGet<{ name: string }>("/api/shops/me"),
    apiPublicGet<{ available: boolean }>("/api/auth/email-change/available"),
    apiGet<NotificationsResponse>("/api/notifications"),
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
      {/* Appearance is per-PERSON too - the dashboard theme is about the
          reader's eyes, and never leaks to what clients see. */}
      <AppearanceCard initialTheme={me.data?.theme ?? "dark"} />
      {/* Notifications are per-PERSON (a barber's own chair, his own phone),
          so they belong here rather than with the shop settings. */}
      {notify.data && (
        <NotificationsCard
          initial={notify.data.prefs}
          devices={notify.data.devices}
          shopNotifyPhone={notify.data.shopNotifyPhone}
        />
      )}
      <AdvancedCard timezone={notify.data?.timezone ?? null} />
    </main>
  );
}
