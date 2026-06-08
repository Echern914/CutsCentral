import Link from "next/link";
import { Card } from "@/components/ui/Card";

export interface ActivityItem {
  type: "nudge" | "visit";
  at: string;
  who: string;
  detail: string;
}

export function ActivityFeed({
  items,
  seeAllHref,
}: {
  items: ActivityItem[];
  seeAllHref?: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">Recent activity</h2>
        {seeAllHref && (
          <Link href={seeAllHref} className="text-xs text-gold hover:underline">
            See all
          </Link>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-subtle">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-3.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  item.type === "nudge" ? "bg-gold" : "bg-emerald-soft"
                }`}
              />
              <span className="text-sm text-offwhite">{item.who}</span>
              <span className="text-xs text-muted">{item.detail}</span>
              <span className="ml-auto text-xs text-muted">
                {new Date(item.at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
