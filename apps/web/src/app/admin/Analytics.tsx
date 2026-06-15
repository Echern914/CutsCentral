import { Card } from "@/components/ui/Card";

export interface Analytics {
  days: number;
  since: string;
  completedVisits: number;
  visitsByDay: { date: string; count: number }[];
  topServices: { name: string; count: number }[];
  topRewards: { name: string; count: number }[];
  rewardRedemptions: number;
  promoRedemptions: number;
  sms: {
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
    ledToBooking: number;
  };
}

/**
 * Platform usage tracker for the operator: the "what's actually happening"
 * view. All server-rendered, no chart lib - a CSS bar sparkline for the visit
 * trend and proportion bars for the top lists, to match the rest of /admin.
 */
export function AnalyticsSection({ a }: { a: Analytics }) {
  const peak = Math.max(1, ...a.visitsByDay.map((d) => d.count));
  const smsTotal = a.sms.sent + a.sms.failed + a.sms.skipped + a.sms.pending;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">Activity</h2>
        <span className="text-xs text-muted">Last {a.days} days</span>
      </div>

      {/* Headline counts for the window. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Visits" value={a.completedVisits} hint="completed" accent />
        <Stat label="Reward redemptions" value={a.rewardRedemptions} />
        <Stat label="Promo redemptions" value={a.promoRedemptions} />
        <Stat
          label="Texts → rebooking"
          value={a.sms.ledToBooking}
          hint={`${a.sms.sent} sent`}
        />
      </div>

      {/* Visits-over-time trend. */}
      <Card className="mt-3 p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted">Visits per day</p>
        {a.completedVisits === 0 ? (
          <Empty>No completed visits in this window yet.</Empty>
        ) : (
          <div className="flex h-32 items-end gap-[3px]">
            {a.visitsByDay.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.count}`}
                className="flex-1 rounded-t-sm bg-gold/70 transition-colors hover:bg-gold"
                style={{ height: `${Math.max(2, (d.count / peak) * 100)}%` }}
              />
            ))}
          </div>
        )}
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <TopList
          title="Top services"
          empty="No services recorded yet."
          rows={a.topServices}
        />
        <TopList
          title="Top rewards redeemed"
          empty="No rewards redeemed yet."
          rows={a.topRewards}
        />
      </div>

      {/* SMS engagement breakdown. */}
      <Card className="mt-3 p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted">SMS activity</p>
        {smsTotal === 0 ? (
          <Empty>No messages sent in this window.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini label="Sent" value={a.sms.sent} />
            <Mini label="Failed" value={a.sms.failed} danger={a.sms.failed > 0} />
            <Mini label="Skipped" value={a.sms.skipped} />
            <Mini label="Led to rebooking" value={a.sms.ledToBooking} accent />
          </div>
        )}
      </Card>
    </section>
  );
}

function TopList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { name: string; count: number }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-muted">{title}</p>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-offwhite">{r.name}</span>
                <span className="shrink-0 text-muted">{r.count}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-charcoal-700">
                <div
                  className="h-full rounded-full bg-gold/70"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-2xl ${accent ? "text-gold" : "text-offwhite"}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function Mini({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: number;
  accent?: boolean;
  danger?: boolean;
}) {
  const color = danger ? "text-danger-soft" : accent ? "text-gold" : "text-offwhite";
  return (
    <div>
      <p className={`font-display text-xl ${color}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}
