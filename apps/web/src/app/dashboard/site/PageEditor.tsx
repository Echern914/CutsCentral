"use client";

import { useMemo, useState, useTransition } from "react";
import {
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_PAGE_FONT,
  DEFAULT_SECTION_ORDER,
  LAYOUT_STYLES,
  LAYOUT_STYLE_KEYS,
  PAGE_FONTS,
  PAGE_FONT_KEYS,
  PAGE_THEMES,
  type LayoutStyleKey,
  type PageFontKey,
  type PageSectionKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { ShopPageSettings } from "./page";
import type { ShopPageData } from "@/app/s/[slug]/page";
import { savePageAction } from "./actions";
import { GalleryEditor } from "./GalleryEditor";
import { ImageField } from "./ImageField";
import { SectionOrderEditor } from "./SectionOrderEditor";
import { LivePreview } from "./LivePreview";

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
  const [theme, setTheme] = useState<string>(settings.theme);
  const [bio, setBio] = useState(settings.bio ?? "");
  const [logoUrl, setLogoUrl] = useState(settings.logoUrl ?? "");
  const [accentColor, setAccentColor] = useState(settings.accentColor ?? "");
  const [heroImageUrl, setHeroImageUrl] = useState(settings.heroImageUrl ?? "");
  const [instagramHandle, setInstagramHandle] = useState(settings.instagramHandle ?? "");
  const [hoursText, setHoursText] = useState(settings.hoursText ?? "");
  const [gallery, setGallery] = useState(settings.gallery ?? []);
  const [fontKey, setFontKey] = useState<PageFontKey>(
    (settings.fontKey as PageFontKey) in PAGE_FONTS ? (settings.fontKey as PageFontKey) : DEFAULT_PAGE_FONT,
  );
  const [layoutStyle, setLayoutStyle] = useState<LayoutStyleKey>(
    (settings.layoutStyle as LayoutStyleKey) in LAYOUT_STYLES
      ? (settings.layoutStyle as LayoutStyleKey)
      : DEFAULT_LAYOUT_STYLE,
  );
  const [sectionOrder, setSectionOrder] = useState<PageSectionKey[]>(
    settings.sectionOrder?.length ? (settings.sectionOrder as PageSectionKey[]) : DEFAULT_SECTION_ORDER,
  );
  const [takesRequests, setTakesRequests] = useState(settings.takesRequests);
  const [notifyPhone, setNotifyPhone] = useState(settings.notifyPhone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [showPreviewMobile, setShowPreviewMobile] = useState(false);

  const pageUrl = `${appBase}/s/${slug || "your-shop"}`;
  const activeTheme = PAGE_THEMES[(theme as PageThemeKey) in PAGE_THEMES ? (theme as PageThemeKey) : "classic"];
  const validHex = /^#[0-9a-fA-F]{6}$/.test(accentColor);
  const previewAccent = validHex ? accentColor : activeTheme.accent;

  // Map the in-progress editor state onto the public ShopPageData shape so the
  // live preview renders EXACTLY what clients will see (same component).
  const previewData: ShopPageData = useMemo(
    () => ({
      name: settings.name,
      slug: slug || "your-shop",
      bio: bio.trim() || null,
      theme,
      logoUrl: logoUrl.trim() || null,
      heroImageUrl: heroImageUrl.trim() || null,
      accentColor: validHex ? accentColor : null,
      instagramHandle: instagramHandle.trim().replace(/^@/, "") || null,
      hoursText: hoursText.trim() || null,
      gallery,
      fontKey,
      layoutStyle,
      sectionOrder,
      bookingUrl: settings.bookingUrl,
      takesRequests,
      punchesPerVisit: settings.punchesPerVisit,
      // Rewards/promotions aren't edited here; the preview shows the page chrome.
      // (They render live on the real page.) Empty keeps the preview honest about
      // what's editable on THIS screen.
      rewards: [],
      promotions: [],
    }),
    [
      settings.name,
      settings.bookingUrl,
      settings.punchesPerVisit,
      slug,
      bio,
      theme,
      logoUrl,
      heroImageUrl,
      accentColor,
      validHex,
      instagramHandle,
      hoursText,
      gallery,
      fontKey,
      layoutStyle,
      sectionOrder,
      takesRequests,
    ],
  );

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
        gallery: gallery.map((g) => ({ url: g.url, ...(g.caption?.trim() ? { caption: g.caption.trim() } : {}) })),
        fontKey,
        layoutStyle,
        sectionOrder,
        takesRequests,
        notifyPhone: notifyPhone.trim(),
      });
      if (r.ok) {
        toast("Your page is saved", "success");
        setSavedOnce(true);
      } else {
        setError(r.error ?? "Could not save");
      }
    });
  }

  function copyUrl() {
    navigator.clipboard
      ?.writeText(pageUrl)
      .then(() => toast("Page link copied", "success"))
      .catch(() => toast("Couldn't copy link", "error"));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* ---------------- Controls ---------------- */}
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
              className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              Copy
            </button>
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
            >
              Open
            </a>
            <button
              onClick={() => setEnabled((v) => !v)}
              className={cn(
                "rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out",
                enabled ? "bg-emerald-soft/15 text-emerald-soft" : "border border-subtle text-muted hover:bg-charcoal-700",
              )}
            >
              {enabled ? "Live" : "Hidden"}
            </button>
          </div>
        </Card>

        {/* Look & feel */}
        <Card className="overflow-hidden">
          <CardHeader title="Look & feel" subtitle="Pick a vibe, then make it yours." />
          <div className="flex flex-col gap-6 px-5 py-5">
            {/* Theme swatches */}
            <div>
              <p className={`mb-2 ${labelCls}`}>Theme</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(Object.keys(PAGE_THEMES) as PageThemeKey[]).map((key) => {
                  const t = PAGE_THEMES[key];
                  const active = theme === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setTheme(key)}
                      className={cn(
                        "rounded-2xl border p-3 text-left transition-[border-color,box-shadow] duration-150 ease-out",
                        active ? "border-gold/60 shadow-glow-sm" : "border-subtle hover:border-subtle-strong",
                      )}
                      style={{ backgroundColor: t.bg }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="h-4 w-4 rounded-full" style={{ backgroundColor: t.accent }} aria-hidden />
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
            </div>

            {/* Font pairing */}
            <div>
              <p className={`mb-2 ${labelCls}`}>Typography</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {PAGE_FONT_KEYS.map((key) => {
                  const f = PAGE_FONTS[key];
                  const active = fontKey === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setFontKey(key)}
                      className={cn(
                        "rounded-xl border p-3 text-left transition-colors duration-150 ease-out",
                        active ? "border-gold/60 bg-gold/5" : "border-subtle hover:border-subtle-strong",
                      )}
                    >
                      <p className="text-base leading-tight text-offwhite" style={{ fontFamily: `var(${f.displayVar})` }}>
                        Aa
                      </p>
                      <p className="mt-1 text-xs font-medium text-offwhite">{f.label}</p>
                      <p className="text-[10px] text-muted">{f.hint}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Layout / shape + accent color */}
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <p className={`mb-2 ${labelCls}`}>Shape</p>
                <div className="flex gap-2">
                  {LAYOUT_STYLE_KEYS.map((key) => {
                    const l = LAYOUT_STYLES[key];
                    const active = layoutStyle === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setLayoutStyle(key)}
                        className={cn(
                          "flex flex-1 flex-col items-center gap-2 rounded-xl border p-3 transition-colors duration-150 ease-out",
                          active ? "border-gold/60 bg-gold/5" : "border-subtle hover:border-subtle-strong",
                        )}
                      >
                        <span
                          className="h-7 w-7 border-2 border-offwhite/70"
                          style={{ borderRadius: l.buttonRadius === "9999px" ? "9999px" : l.radius }}
                          aria-hidden
                        />
                        <span className="text-[11px] text-offwhite">{l.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className={labelCls}>
                Accent color
                <span className="mt-2 flex items-center gap-2">
                  <input
                    type="color"
                    value={previewAccent}
                    onChange={(e) => setAccentColor(e.target.value.toUpperCase())}
                    className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-subtle bg-transparent p-0.5"
                    aria-label="Pick accent color"
                  />
                  <input
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    placeholder={activeTheme.accent}
                    className={`${field} font-mono`}
                  />
                  {accentColor && (
                    <button
                      type="button"
                      onClick={() => setAccentColor("")}
                      className="shrink-0 text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite"
                    >
                      Reset
                    </button>
                  )}
                </span>
                <span className="mt-1 block text-[11px] text-muted/80">Overrides the theme&apos;s accent.</span>
              </label>
            </div>

            {/* Logo + hero (uploads) */}
            <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
              <ImageField
                label="Logo"
                kind="logo"
                aspect="square"
                value={logoUrl}
                onChange={setLogoUrl}
                hint="Square works best."
              />
              <ImageField
                label="Hero banner"
                kind="hero"
                aspect="video"
                value={heroImageUrl}
                onChange={setHeroImageUrl}
                hint="A wide shot of your shop or work."
              />
            </div>

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
          </div>
        </Card>

        {/* Gallery */}
        <Card className="overflow-hidden">
          <CardHeader title="Photo gallery" subtitle="Upload your best work. Drag to reorder, add a caption." />
          <div className="px-5 py-5">
            <GalleryEditor items={gallery} onChange={setGallery} />
          </div>
        </Card>

        {/* Sections */}
        <Card className="overflow-hidden">
          <CardHeader title="Sections" subtitle="Show, hide, and reorder what's on your page." />
          <div className="px-5 py-5">
            <SectionOrderEditor value={sectionOrder} onChange={setSectionOrder} />
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
                <p className="text-sm text-offwhite">Show a “Request an appointment” form</p>
                <p className="mt-0.5 text-xs text-muted">
                  Replaces the booking button with a form. Leads land in your Requests inbox.
                </p>
              </div>
              <button
                onClick={() => setTakesRequests((v) => !v)}
                className={cn(
                  "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out",
                  takesRequests ? "bg-emerald-soft/15 text-emerald-soft" : "border border-subtle text-muted hover:bg-charcoal-700",
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
                We&apos;ll text this number when a request comes in. Leave blank to just check the Requests inbox.
              </span>
            </label>
          </div>
        </Card>

        {/* Save bar */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            disabled={pending || slug.trim().length < 3}
            onClick={save}
            className="rounded-full bg-gold px-6 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save page"}
          </button>
          <button
            onClick={() => setShowPreviewMobile((v) => !v)}
            className="rounded-full border border-subtle px-5 py-2.5 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 lg:hidden"
          >
            {showPreviewMobile ? "Hide preview" : "Preview"}
          </button>
          {savedOnce && !error && !pending && (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-emerald-soft underline-offset-2 hover:underline"
            >
              Saved ✓ View your live page →
            </a>
          )}
          {error && <span className="text-sm text-danger-soft">{error}</span>}
        </div>

        {/* Mobile preview (inline, toggled) */}
        {showPreviewMobile && (
          <div className="lg:hidden">
            <LivePreview data={previewData} />
          </div>
        )}
      </div>

      {/* ---------------- Live preview (desktop, sticky) ---------------- */}
      <aside className="hidden lg:block">
        <div className="sticky top-6">
          <LivePreview data={previewData} />
        </div>
      </aside>
    </div>
  );
}
