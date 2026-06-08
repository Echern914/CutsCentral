import Link from "next/link";
import { Card } from "@/components/ui/Card";

export interface Leader {
  name: string;
  balance: number;
}

export function Leaderboard({
  leaders,
  seeAllHref,
}: {
  leaders: Leader[];
  seeAllHref?: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">Punch leaderboard</h2>
        {seeAllHref && (
          <Link href={seeAllHref} className="text-xs text-gold hover:underline">
            See all
          </Link>
        )}
      </div>
      {leaders.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No punches yet.</p>
      ) : (
        <ul className="divide-y divide-subtle">
          {leaders.map((l, i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-3.5">
              <span className="w-5 font-display text-sm text-muted">{i + 1}</span>
              <span className="text-sm text-offwhite">{l.name}</span>
              <span className="ml-auto font-display text-gold">{l.balance}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
