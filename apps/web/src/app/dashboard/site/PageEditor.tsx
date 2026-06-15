"use client";

import { useState, useTransition } from "react";
import { PAGE_THEMES, type PageThemeKey } from "@chairback/config/constants";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { ShopPageSettings } from "./page";
import { savePageAction } from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

export function PageEditor({
  settings,
  appBase,
}: {
  settings: ShopPageSettings;
  appBase: string;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [slug, setSlug] = useState(settings.slug ?? "");
  const [enabled, setEnabled] = useState(settings.publicPageEnabled);
  const [theme, setTheme] = useState(settings.theme);
  const [bio, setBio] = useState(settings.bio ?? "");
  const [logoUrl, setLogoUrl] = useState(settings.logoUrl ?? "");
  const [accentColor, setAccentColor] = useState(settings.accentColor ?? "");
  const [heroImageUrl, setHeroImageUrl] = useState(settings.heroImageUrl ?? "");
  const [instagramHandle, setInstagramHandle] = useState(settings.instagramHandle ?? "");
  const [hoursText, setHoursText] = useState(settings.hoursText ?? "");
  const [gallery, setGallery] = useState(settings.galleryUrls.join("\n"));
  const [takesRequests, setTakesRequests] = useState(settings.takesRequests);
  const [notifyPhone, setNotifyPhone] = useState(settings.notifyPhone ?? "");
  const [error, setError] = useState<string | null>(null);

  const pageUrl = `${appBase}/s/${slug || "your-shop"}`;
  const activeTheme = PAGE_THEMES[(theme as PageThemeKey) in PAGE_THEMES ? (theme as PageThemeKey) : "classic"];
  const previewAccent = /^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : activeTheme.accent;

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await savePageAction({
        slug: slug.trim().toLowerCase(),
        publicPageEnabled: enabled,
        theme,
        bio: bio.trim(),
        logoUrl: logoUrl.trim(),
        accentColor: accentColor.trim(),
        heroImageUrl: heroImageUrl.trim(),
        instagramHandle: instagramHandle.trim(),
        hoursText: hoursText.trim(),
        galleryUrls: gallery
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6),
        takesRequests,
        notifyPhone: notifyPhone.trim(),
      });
      if (r.ok) toast("Page saved", "success");
      else setError(r.error ?? "Could not save");
    });
  }

  function copyUrl() {
    navigator.clipboard
      ?.writeText(pageUrl)
      .then(() => toast("Page link copied", "success"))
      .catch(() => toast("Couldn't copy link", "error"));
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Live link */}
      <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted">Your public link</p>
          <p className="truncate font-mono text-sm text-offwhite">{pageUrl}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyUrl}
            className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700"
          >
            Copy
          </button>
          <a
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold hover:bg-gold/10"
          >
            Open
          </a>
          <button
            onClick={() => setEnabled((v) => !v)}
            className={cn(
              "rounded-full px-4 py-2 text-xs font-medium",
              enabled
                ? "bg-emerald-soft/15 text-emerald-soft"
                : "border border-subtle text-muted hover:bg-charcoal-700",
            )}
          >
            {enabled ? "Live" : "Hidden"}
          </button>
        </div>
      </Card>

      {/* Look & feel */}
      <Card className="overflow-hidden">
        <CardHeader title="Look & feel" subtitle="Pick a vibe, then make it yours." />
        <div className="flex flex-col gap-5 px-5 py-5">
          {/* Theme swatches */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(PAGE_THEMES) as PageThemeKey[]).map((key) => {
              const t = PAGE_THEMES[key];
              const active = theme === key;
              return (
                <button
                  key={key}
                  onClick={() => setTheme(key)}
                  className={cn(
                    "rounded-2xl border p-3 text-left transition-all",
                    active ? "border-gold/60 shadow-glow-sm" : "border-subtle hover:border-subtle-strong",
                  )}
                  style={{ backgroundColor: t.bg }}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-4 w-4 rounded-full"
                      style={{ backgroundColor: t.accent }}
                      aria-hidden
                    />
                    <span
                      className="h-4 w-8 rounded-full"
                      style={{ backgroundColor: t.surface, border: `1px solid ${t.border}` }}
                      aria-hidden
                    />
                  </div>
                  <p className="mt-2 text-xs font-medium" style={{ color: t.text }}>
                    {t.label}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelCls}>
              Page handle (the /s/… part of your link)
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="dricks-barbershop"
                maxLength={40}
                className={`mt-1 ${field} font-mono`}
              />
            </label>
            <label className={labelCls}>
              Accent color (hex, optional, overrides the theme&apos;s)
              <span className="mt-1 flex items-center gap-2">
                <input
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  placeholder={activeTheme.accent}
                  className={field}
                />
                <span
                  className="h-8 w-8 shrink-0 rounded-lg border border-subtle"
                  style={{ backgroundColor: previewAccent }}
                  aria-hidden
                />
              </span>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelCls}>
              Logo URL
              <input
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://…/logo.png"
                className={`mt-1 ${field}`}
              />
            </label>
            <label className={labelCls}>
              Hero banner image URL (optional)
              <input
                value={heroImageUrl}
                onChange={(e) => setHeroImageUrl(e.target.value)}
                placeholder="https://…/storefront.jpg"
                className={`mt-1 ${field}`}
              />
            </label>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card className="overflow-hidden">
        <CardHeader title="About" subtitle="What clients see on your page." />
        <div className="flex flex-col gap-5 px-5 py-5">
          <label className={labelCls}>
            Short bio
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Precision fades and beard work in downtown Wilmington. By appointment."
              className={`mt-1 ${field} resize-none`}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelCls}>
              Instagram handle
              <input
                value={instagramHandle}
                onChange={(e) => setInstagramHandle(e.target.value)}
                placeholder="@drickscuts"
                maxLength={31}
                className={`mt-1 ${field}`}
              />
            </label>
            <label className={labelCls}>
              Hours (free text, line breaks kept)
              <textarea
                value={hoursText}
                onChange={(e) => setHoursText(e.target.value)}
                rows={3}
                maxLength={400}
                placeholder={"Tue-Fri 9-6\nSat 8-3\nClosed Sun-Mon"}
                className={`mt-1 ${field} resize-none`}
              />
            </label>
          </div>
          <label className={labelCls}>
            Gallery photo URLs (one per line, up to 6)
            <textarea
              value={gallery}
              onChange={(e) => setGallery(e.target.value)}
              rows={3}
              placeholder={"https://…/cut1.jpg\nhttps://…/cut2.jpg"}
              className={`mt-1 ${field} resize-none font-mono`}
            />
          </label>
        </div>
      </Card>

      {/* Appointment requests */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Appointment requests"
          subtitle="No online booking? Let clients request a time right from your page."
        />
        <div className="flex flex-col gap-5 px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-offwhite">
                Show a “Request an appointment” form
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Replaces the booking button with a form. Leads land in your{" "}
                Requests inbox.
              </p>
            </div>
            <button
              onClick={() => setTakesRequests((v) => !v)}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-xs font-medium",
                takesRequests
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "border border-subtle text-muted hover:bg-charcoal-700",
              )}
            >
              {takesRequests ? "On" : "Off"}
            </button>
          </div>
          <label className={labelCls}>
            Text me new requests at (optional)
            <input
              value={notifyPhone}
              onChange={(e) => setNotifyPhone(e.target.value)}
              placeholder="(302) 555-0142"
              maxLength={40}
              className={`mt-1 ${field}`}
            />
            <span className="mt-1 block text-[11px] text-muted/80">
              We&apos;ll text this number when a request comes in. Leave blank to
              just check the Requests inbox.
            </span>
          </label>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <button
          disabled={pending || slug.trim().length < 3}
          onClick={save}
          className="rounded-full bg-gold px-6 py-2.5 text-sm font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save page"}
        </button>
        {error && <span className="text-sm text-danger-soft">{error}</span>}
      </div>
    </div>
  );
}
