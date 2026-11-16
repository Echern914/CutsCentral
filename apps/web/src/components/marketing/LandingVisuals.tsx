/**
 * Static pictures of the product for the homepage: the Today screen on a
 * phone, and the week calendar on a computer. Plain markup in theme tokens,
 * so both flip with light and dark, and no client JavaScript.
 *
 * Every name and number here is SAMPLE data, and each picture is one
 * `role="img"` with a label, so a screen reader hears a description rather
 * than a list of strangers' names.
 */

const STATUS = {
  paid: "text-emerald-soft",
  coming: "text-info-soft",
  open: "text-gold",
  asked: "text-warning-soft",
  booked: "text-muted",
} as const;

const DAY: { time: string; who: string; status: keyof typeof STATUS; label: string }[] = [
  { time: "9:30", who: "Andre Bell", status: "paid", label: "Paid" },
  { time: "12:00", who: "Will Park", status: "coming", label: "On the way" },
  { time: "1:30", who: "Open · 1h 30m", status: "open", label: "Fill it" },
  { time: "3:00", who: "Sofia Reyes", status: "asked", label: "Asked" },
  { time: "4:30", who: "Marcus Lee", status: "booked", label: "Booked" },
];

const FLOAT =
  "absolute hidden rounded-xl border border-subtle bg-charcoal-800 px-3.5 py-3 text-[13px] leading-[18px] shadow-[0_16px_32px_-16px_rgba(26,24,20,0.35)] sm:block";

export function HeroPhone() {
  return (
    <div
      role="img"
      aria-label="The ChairBack app on a phone, showing today's schedule"
      className="relative mx-auto h-[560px] w-full max-w-[520px] sm:h-[600px]"
    >
      <div className="absolute inset-y-0 left-1/2 w-[280px] -translate-x-1/2 overflow-hidden rounded-[44px] border-[10px] border-primary bg-charcoal-900 shadow-[0_40px_80px_-40px_rgba(26,24,20,0.45)] sm:left-auto sm:right-6 sm:w-[296px] sm:translate-x-0">
        <div className="px-4 pt-8">
          <p className="text-xs text-muted">Monday, November 16</p>
          <p className="font-display text-[28px] leading-[34px]">Today</p>

          <div className="mt-3 grid grid-cols-3 divide-x divide-subtle rounded-[10px] border border-subtle bg-charcoal-800">
            {[
              ["Booked", "$200"],
              ["Visits left", "4"],
              ["Open", "1h 30m"],
            ].map(([k, v]) => (
              <div key={k} className="px-2.5 py-2">
                <p className="text-[10px] leading-[14px] text-muted">{k}</p>
                <p className="font-display text-[17px] leading-[22px] tabular-nums">{v}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-xl border border-subtle bg-charcoal-800 p-3">
            <p className="text-[10px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-gold">
              Up next · 11:00
            </p>
            <p className="text-[15px] font-semibold leading-[22px]">Jordan D.</p>
            <p className="text-xs text-muted">Taper · $45 · Gold</p>
            <div className="mt-2.5 flex h-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-on-primary">
              Check in
            </div>
          </div>

          <div className="mt-3 divide-y divide-subtle rounded-xl border border-subtle bg-charcoal-800 text-xs">
            {DAY.map((r) => (
              <div key={r.time} className="flex gap-2.5 px-3 py-2.5 tabular-nums">
                <span className="w-9 shrink-0 text-muted">{r.time}</span>
                <span
                  className={`min-w-0 flex-1 truncate ${r.status === "open" ? "text-muted" : "font-semibold"}`}
                >
                  {r.who}
                </span>
                <span className={`font-semibold ${STATUS[r.status]}`}>{r.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={`${FLOAT} left-0 top-24 w-[230px]`}>
        <p className="text-[11px] font-semibold text-muted">New booking</p>
        <p className="mt-0.5 font-semibold">Jordan D. · Beard trim</p>
        <p className="tabular-nums text-muted">Tue, Nov 17 at 1:30 PM</p>
      </div>
      <div className={`${FLOAT} left-4 top-[380px] flex w-[210px] items-center gap-2.5`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-soft/15 text-emerald-soft">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <span>
          <span className="block font-semibold">Deposit paid</span>
          <span className="block tabular-nums text-muted">$10.00 · Visa 4242</span>
        </span>
      </div>
    </div>
  );
}

type Bar = [top: number, height: number, who: string, kind?: "next" | "open" | "blocked" | "paid" | "coming" | "asked"];

/** Six days of a busy week. Offsets are px on a 26px-per-half-hour grid. */
const WEEK: { day: string; bars: Bar[] }[] = [
  {
    day: "Mon 16",
    bars: [
      [26, 50, "Andre Bell", "paid"],
      [104, 30, "Jordan D.", "next"],
      [156, 20, "Will Park", "coming"],
      [234, 76, "Open · 1:30", "open"],
      [312, 26, "Sofia Reyes", "asked"],
    ],
  },
  {
    day: "Tue 17",
    bars: [
      [52, 30, "Chris Ortiz"],
      [104, 50, "Devon King"],
      [208, 50, "Blocked", "blocked"],
      [286, 30, "Nate Brooks"],
    ],
  },
  {
    day: "Wed 18",
    bars: [
      [0, 30, "Tyler Ames"],
      [52, 50, "Ray Holt"],
      [182, 30, "Omar Said"],
      [338, 30, "Ben Cho"],
    ],
  },
  {
    day: "Thu 19",
    bars: [
      [26, 30, "Sam Rivera"],
      [104, 30, "Eli Grant"],
      [156, 50, "Jay Moss"],
      [260, 26, "Leo Kim"],
      [312, 30, "Max Diaz"],
    ],
  },
  {
    day: "Fri 20",
    bars: [
      [0, 50, "Isaiah Ross"],
      [78, 30, "Carlos Vega"],
      [130, 30, "Noah Price"],
      [208, 30, "Zion Webb"],
      [260, 50, "Gabe Stone"],
    ],
  },
  {
    day: "Sat 21",
    bars: [
      [0, 30, "Drew Fox"],
      [39, 30, "Kofi Mensah"],
      [78, 50, "Ian Shaw"],
      [143, 30, "Rico Banks"],
      [182, 30, "Paul Ng"],
      [234, 30, "Dom Reed"],
      [273, 30, "Vic Hale"],
      [312, 50, "Tom Ruiz"],
    ],
  },
];

const BAR_KIND: Record<NonNullable<Bar[3]> | "plain", string> = {
  plain: "bg-charcoal-700 border-l-[3px] border-l-muted",
  paid: "bg-charcoal-700 border-l-[3px] border-l-emerald-soft",
  coming: "bg-charcoal-700 border-l-[3px] border-l-info-soft",
  asked: "bg-warning-soft/10 border-l-[3px] border-l-warning-soft",
  next: "bg-primary text-on-primary border-l-[3px] border-l-gold",
  open: "border-[1.5px] border-dashed border-subtle-strong bg-charcoal-800 font-medium text-muted",
  blocked: "border border-dashed border-subtle bg-charcoal-900 font-medium text-muted",
};

const NAV = ["Today", "Calendar", "Clients", "Insights", "More"];

export function WeekPreview() {
  return (
    <div
      role="img"
      aria-label="The ChairBack week calendar on a computer"
      className="min-w-0 rounded-2xl border border-subtle bg-charcoal-900 p-2 shadow-[0_30px_60px_-36px_rgba(26,24,20,0.35)]"
    >
      <div className="flex h-[440px] gap-2">
        <div className="hidden w-[132px] shrink-0 flex-col gap-1 px-1.5 py-2 text-xs text-muted md:flex">
          <p className="flex items-center gap-1.5 px-1 pb-2.5 font-semibold text-offwhite">
            <span className="h-[18px] w-[18px] rounded-[5px] bg-primary" />
            Your shop
          </p>
          {NAV.map((n) => (
            <p
              key={n}
              className={`rounded-md px-2 py-1.5 ${n === "Calendar" ? "bg-charcoal-800 font-semibold text-offwhite ring-1 ring-offwhite/10" : ""}`}
            >
              {n}
            </p>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-subtle bg-charcoal-800">
          <div className="flex items-center justify-between border-b border-subtle px-3.5 py-2.5">
            <span className="font-display text-sm sm:text-base">November 16 – 22</span>
            <span className="flex h-[26px] items-center rounded-md bg-primary px-2.5 text-[11px] font-semibold text-on-primary">
              New appointment
            </span>
          </div>
          <div className="grid flex-1 grid-cols-3 md:grid-cols-6">
            {WEEK.map((col, i) => (
              <div
                key={col.day}
                className={`flex min-w-0 flex-col ${i > 0 ? "border-l border-subtle" : ""} ${i >= 3 ? "hidden md:flex" : ""}`}
              >
                <p
                  className={`border-b border-subtle px-2 py-2 text-[11px] tabular-nums ${i === 0 ? "font-semibold text-offwhite" : "text-muted"}`}
                >
                  {col.day}
                </p>
                <div className="relative flex-1 bg-[linear-gradient(rgb(var(--cb-fg)/0.06)_1px,transparent_1px)] bg-[length:100%_52px]">
                  {col.bars.map(([top, height, who, kind]) => (
                    <div
                      key={`${top}-${who}`}
                      className={`absolute inset-x-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-[5px] px-1.5 py-[3px] text-[11px] font-semibold leading-[14px] ${BAR_KIND[kind ?? "plain"]}`}
                      style={{ top, height }}
                    >
                      {who}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
