import { APP_NAME } from "@chairback/config/constants";

/**
 * The one card every step of the invited-barber flow renders inside.
 *
 * These screens are read on a phone, in a browser sheet, by someone who is
 * mid-task and does not yet have an account - the least forgiving audience a
 * page can have. So each state gets the same frame (wordmark, mark, one
 * sentence, one obvious action) and differs only in tone, rather than each
 * dead-end inventing its own layout.
 *
 * Sizing is deliberate, not decorative: every action rendered through
 * `actions` is at least 44px tall (Apple's minimum touch target) and body copy
 * is 16px, the threshold below which iOS Safari zooms the page on focus.
 */

type Tone = "neutral" | "success" | "problem";

const TONE_RING: Record<Tone, string> = {
  neutral: "border-white/12 bg-white/5 text-muted",
  success: "border-gold/40 bg-gold/10 text-gold",
  problem: "border-white/12 bg-white/5 text-muted",
};

export function FlowCard({
  title,
  tone = "neutral",
  glyph,
  children,
  actions,
  footnote,
}: {
  title: string;
  tone?: Tone;
  /** A single character or tiny node for the emblem; the mark by default. */
  glyph?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-10">
      <div
        className="absolute left-1/2 top-1/3 -z-10 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-3xl"
        aria-hidden
      />
      <p className="mb-4 text-center text-xs uppercase tracking-[0.25em] text-gold">
        {APP_NAME}
      </p>
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <div
          className={`mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border text-lg ${TONE_RING[tone]}`}
          aria-hidden
        >
          {glyph ?? "✂"}
        </div>
        <h1 className="font-display text-xl text-offwhite">{title}</h1>
        <div className="mt-2 text-base leading-relaxed text-muted">{children}</div>
        {actions && <div className="mt-6 flex flex-col gap-3">{actions}</div>}
      </div>
      {footnote && (
        <p className="mt-5 text-center text-sm text-muted">{footnote}</p>
      )}
    </main>
  );
}

/** Primary action. Brass fill, the only one of these per screen. */
export function FlowPrimaryLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
    >
      {children}
    </a>
  );
}

/** Secondary action. Outline, for the way out rather than the way on. */
export function FlowSecondaryLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-subtle px-5 py-3 text-sm font-medium text-offwhite transition-colors duration-200 ease-out hover:bg-white/5"
    >
      {children}
    </a>
  );
}
