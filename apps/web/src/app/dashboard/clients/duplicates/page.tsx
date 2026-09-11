import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { DuplicateReview, type DuplicateGroupView } from "./DuplicateReview";

interface DuplicatesResponse {
  total: number;
  groups: DuplicateGroupView[];
}

export default async function DuplicatesPage() {
  const res = await apiGet<DuplicatesResponse>("/api/dashboard/clients/duplicates");
  const groups = res.data?.groups ?? [];
  const total = res.data?.total ?? 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-5">
      <header className="mb-6">
        <Link
          href="/dashboard/clients"
          className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          ← Clients
        </Link>
        <h1 className="mt-1 font-display text-3xl tracking-tight">Possible duplicates</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          These clients share a phone number or email. Merging moves everything onto the record you
          keep and archives the others. Family members often share a number, so check before you
          merge.
        </p>
      </header>

      {res.data ? (
        <DuplicateReview groups={groups} />
      ) : (
        <Card className="overflow-hidden">
          <p className="px-5 py-8 text-center text-sm text-muted">
            Couldn&apos;t load possible duplicates. Refresh to try again.
          </p>
        </Card>
      )}

      {total > groups.length && (
        <p className="mt-4 text-center text-xs text-muted">
          Showing {groups.length} of {total}. More appear as you work through these.
        </p>
      )}
    </main>
  );
}
