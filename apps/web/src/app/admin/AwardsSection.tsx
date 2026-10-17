"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AWARD_LIMITS, type AwardStat } from "@chairback/config/providerAward";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import { giveAwardAction, takeBackAwardAction, type GiveAwardInput } from "./actions";

/** GET /api/admin-portal/awards (routes/awardsAdmin.ts). */
export interface AdminAwards {
  month: string;
  monthLabel: string;
  applications: {
    id: string;
    shop: { name: string; slug: string | null };
    applicantName: string | null;
    pitch: string;
    credentials: string | null;
    stats: AwardStat[];
    status: "SUBMITTED" | "WON" | "NOT_CHOSEN";
    createdAt: string;
  }[];
  awards: {
    id: string;
    shop: { name: string; slug: string | null };
    applicationId: string | null;
    title: string;
    winnerName: string;
    specialty: string | null;
    headline: string;
    description: string;
    stats: AwardStat[];
    /** Nothing posts until the winner approves. */
    status: "PENDING" | "APPROVED" | "DECLINED";
  }[];
}

const STATUS: Record<AdminAwards["awards"][number]["status"], { label: string; cls: string }> = {
  PENDING: { label: "Waiting for their OK", cls: "border-gold/40 text-gold" },
  APPROVED: { label: "Approved · on their page", cls: "border-emerald-soft/40 text-emerald-soft" },
  DECLINED: { label: "They declined · not posted", cls: "border-subtle text-muted" },
};

const input =
  "w-full rounded-xl border border-subtle bg-charcoal-800 px-3 py-2 text-base text-offwhite placeholder:text-muted sm:text-sm";
const primary =
  "inline-flex min-h-[40px] items-center justify-center rounded-full bg-gold px-4 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";
const quiet =
  "inline-flex min-h-[40px] items-center justify-center rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50";

/**
 * PROVIDER OF THE MONTH - ChairBack picks the winner. Applications come in
 * from shops (with the stats they chose and a pitch); a winner can also be
 * named directly by handle. The winner's public page shows the title, who,
 * the headline (how they won) and the description (why) written here.
 */
export function AwardsSection({ data }: { data: AdminAwards }) {
  // An application already picked (waiting for their OK, or approved) is not
  // offered again - one pick per application.
  const picked = new Set(data.awards.map((w) => w.applicationId).filter(Boolean));
  const open = data.applications.filter((a) => a.status === "SUBMITTED" && !picked.has(a.id));
  return (
    <section className="mt-10" data-qa="awards-section">
      <h2 className="mb-1 font-display text-lg">Provider of the Month · {data.monthLabel}</h2>
      <p className="mb-4 text-sm text-muted">
        Pick a winner from the applications, or name one directly. They see exactly what will show and approve it first; then their page shows it through next month.
      </p>

      {data.awards.length > 0 && (
        <div className="mb-4 flex flex-col gap-3">
          {data.awards.map((a) => (
            <Card key={a.id} className="border-gold/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gold">Winner · {a.title}</p>
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS[a.status].cls}`}>
                  {STATUS[a.status].label}
                </span>
              </div>
              <p className="mt-1 text-sm font-semibold text-offwhite">
                {a.winnerName} <span className="font-normal text-muted">· {a.shop.name}{a.shop.slug ? ` (@${a.shop.slug})` : ""}</span>
              </p>
              {a.specialty && <p className="text-xs text-muted">{a.specialty}</p>}
              <p className="mt-1 text-sm text-gold">{a.headline}</p>
              {a.stats.length > 0 ? (
                <p className="mt-1 text-xs text-muted">{a.stats.map((s) => `${s.label}: ${s.value}`).join(" · ")}</p>
              ) : (
                <p className="mt-1 text-xs text-muted">No stats yet - they have no bookings in the last 30 days.</p>
              )}
              <p className="mt-1 whitespace-pre-line text-sm text-offwhite/80">{a.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {a.shop.slug && (
                  <a href={`/s/${a.shop.slug}`} target="_blank" rel="noopener noreferrer" className={quiet}>
                    View their page
                  </a>
                )}
                <TakeBack id={a.id} slug={a.shop.slug} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mb-4 p-4">
        <p className="text-sm font-semibold text-offwhite">Award directly</p>
        <p className="mt-0.5 text-xs text-muted">By their handle - the last part of their booking link.</p>
        <AwardForm direct />
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-offwhite">
        Applications ({open.length})
      </h3>
      {open.length === 0 ? (
        <p className="text-sm text-muted">No applications waiting this month.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((a) => (
            <li key={a.id} data-qa="award-application">
              <Card className="p-4">
                <p className="text-sm font-semibold text-offwhite">
                  {a.shop.name}
                  {a.shop.slug && <span className="font-normal text-muted"> · @{a.shop.slug}</span>}
                </p>
                {a.applicantName && <p className="text-xs text-muted">{a.applicantName}</p>}
                <p className="mt-2 whitespace-pre-line text-sm text-offwhite/90 [overflow-wrap:anywhere]">{a.pitch}</p>
                {a.credentials && (
                  <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">Credentials: {a.credentials}</p>
                )}
                {a.stats.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {a.stats.map((s) => (
                      <li key={s.key} className="rounded-full border border-subtle px-2.5 py-1 text-xs text-muted">
                        {s.label}: <span className="font-semibold text-offwhite">{s.value}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <AwardForm applicationId={a.id} stats={a.stats} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AwardForm({
  direct = false,
  applicationId,
  stats = [],
}: {
  direct?: boolean;
  applicationId?: string;
  stats?: AwardStat[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(direct);
  const [slug, setSlug] = useState("");
  const [winnerName, setWinnerName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [title, setTitle] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const [keys, setKeys] = useState<string[]>(stats.map((s) => s.key));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  if (!open) {
    return (
      <button type="button" className={`${primary} mt-3`} onClick={() => setOpen(true)}>
        Choose as winner
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const body: GiveAwardInput = {
      ...(direct ? { shopSlug: slug } : { applicationId: applicationId!, statKeys: keys }),
      headline,
      description,
      ...(winnerName.trim() ? { winnerName } : {}),
      ...(specialty.trim() ? { specialty } : {}),
      ...(title.trim() ? { title } : {}),
    };
    try {
      const res = await giveAwardAction(body);
      if (res.ok) {
        toast("Sent to them to approve - it posts once they say yes", "success");
        router.refresh();
      } else {
        setError(
          res.error === "shop_not_found"
            ? "No shop has that handle. Check the last part of their booking link."
            : "Couldn't save the award. Check the fields and try again.",
        );
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2.5">
      {direct && (
        <label className="text-xs text-muted">
          Their handle
          <input className={`${input} mt-1`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="jeracuts" required />
        </label>
      )}
      <label className="text-xs text-muted">
        Name to show (leave empty for the owner&apos;s name)
        <input className={`${input} mt-1`} value={winnerName} maxLength={AWARD_LIMITS.winnerName} onChange={(e) => setWinnerName(e.target.value)} />
      </label>
      <label className="text-xs text-muted">
        What they do (leave empty for their most-booked services)
        <input className={`${input} mt-1`} value={specialty} maxLength={AWARD_LIMITS.specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Knotless braids · Boho locs" />
      </label>
      <label className="text-xs text-muted">
        Title (leave empty to use their business type: Lash Artist, Stylist, Nail Tech…)
        <input className={`${input} mt-1`} value={title} maxLength={AWARD_LIMITS.title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="text-xs text-muted">
        How they won (one line)
        <input className={`${input} mt-1`} value={headline} maxLength={AWARD_LIMITS.headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Most booked in October" required />
      </label>
      <label className="text-xs text-muted">
        Why (a few sentences - shown on their page)
        <textarea className={`${input} mt-1 min-h-[90px]`} value={description} maxLength={AWARD_LIMITS.description} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      {!direct && stats.length > 0 && (
        <fieldset className="text-xs text-muted">
          <legend>Stats to show</legend>
          {stats.map((s) => (
            <label key={s.key} className="mt-1 flex items-center gap-2 text-sm text-offwhite">
              <input
                type="checkbox"
                checked={keys.includes(s.key)}
                onChange={(e) => setKeys((k) => (e.target.checked ? [...k, s.key] : k.filter((x) => x !== s.key)))}
              />
              {s.label}: {s.value}
            </label>
          ))}
        </fieldset>
      )}
      {direct && <p className="text-xs text-muted">Their stats from the last 30 days are added automatically.</p>}
      <FormError className="text-sm">{error}</FormError>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primary} disabled={pending}>
          {pending ? "Saving…" : "Send for their OK"}
        </button>
        {!direct && (
          <button type="button" className={quiet} onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function TakeBack({ id, slug }: { id: string; slug: string | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  if (!confirm) {
    return (
      <button type="button" className={quiet} onClick={() => setConfirm(true)}>
        Take back
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-muted">Take it off their page?</span>
      <button
        type="button"
        className={quiet}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          await takeBackAwardAction(id, slug);
          setPending(false);
          router.refresh();
        }}
      >
        Yes, take back
      </button>
      <button type="button" className={quiet} onClick={() => setConfirm(false)}>
        Keep
      </button>
    </span>
  );
}
