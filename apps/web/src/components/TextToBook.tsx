/**
 * "Text us to book" — the shop's AI receptionist line, shown to CLIENTS.
 *
 * The receptionist only pays off if clients know the number exists, and until
 * now it lived on the barber's BILLING page only. This renders on the surfaces
 * clients actually visit (the public mini-site and their rewards page).
 *
 * The API decides whether there is a number to show at all: it sends non-null
 * only when a text would really be answered (the same gate the inbound handler
 * uses) AND the shop owns its line. So this component never reasons about
 * entitlement — a null number simply renders nothing.
 *
 * Both host pages are WHITE-LABELED per shop, so every color arrives as a prop
 * rather than a dashboard token; the defaults are the dashboard's palette for
 * any unthemed caller.
 *
 * The sms: link is deliberately NOT prefilled with a body — iOS wants
 * `&body=`, Android wants `?body=`, and the wrong one drops the recipient on
 * the other platform. Opening an empty thread works everywhere.
 */
export function TextToBook({
  number,
  shopName,
  accent = "#D4AF37",
  muted = "#A1A1AA",
  text = "#F5F5F4",
  className = "",
}: {
  /** E.164 shop line, or null when the receptionist isn't reachable. */
  number: string | null;
  shopName: string;
  /** The host page's accent/muted/body colors (per-shop theming). */
  accent?: string;
  muted?: string;
  text?: string;
  className?: string;
}) {
  if (!number) return null;
  return (
    <div
      className={`rounded-2xl border px-5 py-4 ${className}`}
      style={{ borderColor: `${accent}55`, backgroundColor: `${accent}14` }}
    >
      <p
        className="text-xs font-semibold uppercase tracking-[0.15em]"
        style={{ color: accent }}
      >
        Text {shopName}
      </p>
      <a
        href={`sms:${number}`}
        className="mt-1 block text-2xl underline-offset-4 hover:underline"
        style={{ color: text, fontFamily: "var(--page-display, inherit)" }}
      >
        {prettyNumber(number)}
      </a>
      <p className="mt-1.5 text-sm" style={{ color: muted }}>
        Ask what&apos;s open, book, reschedule or cancel — just text, any time.
        You&apos;ll get an answer in seconds, day or night.
      </p>
    </div>
  );
}

/** "+15512840878" -> "(551) 284-0878"; unknown shapes pass through unchanged. */
function prettyNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
