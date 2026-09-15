import { Card, CardHeader } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";

export interface SavedByPerson {
  name: string;
  savedAt: string;
}

/** How many names show before the rest fold away. */
const VISIBLE = 5;

/**
 * "Saved your shop" - people who added this shop in their own ChairBack app.
 *
 * Names and dates only, because that is all the API sends: a customer who
 * saved a shop agreed to be seen by name, not to be texted or emailed. If they
 * book, they become a client the ordinary way. Nothing at all renders until
 * somebody has saved the shop.
 */
export function SavedByCard({ total, people }: { total: number; people: SavedByPerson[] }) {
  if (total === 0 || people.length === 0) return null;
  const shown = people.slice(0, VISIBLE);
  const rest = people.slice(VISIBLE);

  return (
    <Card className="p-5">
      <CardHeader
        title={total === 1 ? "1 person saved your shop" : `${total} people saved your shop`}
        subtitle="They added you in their ChairBack app. You see their name, nothing else."
      />
      <PeopleList people={shown} />
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1 text-xs text-gold">Show {rest.length} more</summary>
          <PeopleList people={rest} />
        </details>
      )}
      {total > people.length && (
        <p className="mt-2 text-xs text-muted">Showing the latest {people.length}.</p>
      )}
    </Card>
  );
}

function PeopleList({ people }: { people: SavedByPerson[] }) {
  return (
    <ul className="mt-3 divide-y divide-subtle">
      {people.map((p, i) => (
        <li key={`${p.savedAt}:${i}`} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0 truncate text-sm text-offwhite">{p.name}</span>
          <LocalDate
            iso={p.savedAt}
            options={{ month: "short", day: "numeric" }}
            className="shrink-0 text-xs text-muted"
          />
        </li>
      ))}
    </ul>
  );
}
