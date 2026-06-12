import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { PageEditor } from "./PageEditor";

export const metadata: Metadata = { title: "Your page" };

export interface ShopPageSettings {
  name: string;
  slug: string | null;
  publicPageEnabled: boolean;
  theme: string;
  bio: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  heroImageUrl: string | null;
  instagramHandle: string | null;
  hoursText: string | null;
  galleryUrls: string[];
}

export default async function PageSettingsPage() {
  const res = await apiGet<ShopPageSettings>("/api/shops/me");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your page settings.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Your page</h1>
        <p className="mt-1 text-sm text-muted">
          A public mini-site that looks like your shop — drop the link in your
          Instagram bio. Clients see your brand, your rewards, and your live promos.
        </p>
      </header>
      <PageEditor settings={res.data} appBase={process.env.APP_BASE_URL ?? ""} />
    </main>
  );
}
