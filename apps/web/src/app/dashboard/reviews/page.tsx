import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ReviewModeration } from "./ReviewModeration";

interface ReviewRow {
  id: string;
  rating: number;
  body: string | null;
  authorName: string | null;
  status: "PENDING" | "APPROVED" | "HIDDEN";
  createdAt: string;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="text-sm leading-none" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "text-gold" : "text-charcoal-600"}>
          ★
        </span>
      ))}
    </span>
  );
}

export default async function ReviewsPage() {
  const res = await apiGet<{ reviews: ReviewRow[]; pendingCount: number }>(
    "/api/dashboard/reviews",
  );
  const reviews = res.data?.reviews ?? [];
  const pending = res.data?.pendingCount ?? 0;
  const approved = reviews.filter((r) => r.status === "APPROVED").length;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <Link href="/dashboard" className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite">
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">Reviews</h1>
      <p className="mb-6 text-sm text-muted">
        Reviews from your public page. Approve one to publish it
        {pending > 0 ? ` · ${pending} awaiting approval` : ""}
        {approved > 0 ? ` · ${approved} live` : ""}.
      </p>

      <Card className="overflow-hidden">
        {reviews.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-muted">
              No reviews yet. Customers can leave one on your{" "}
              <Link href="/dashboard/site" className="text-gold hover:underline">
                public page
              </Link>
              ; approved reviews show there with a star rating.
            </p>
            {/* Labeled example so you can see how a review will look. Not real, not public. */}
            <div className="mx-auto mt-5 max-w-md rounded-lg border border-dashed border-subtle p-4 text-left opacity-70">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-muted/70">
                Example — this is how a review will appear
              </p>
              <div className="flex items-center justify-between">
                <Stars value={5} />
                <span className="text-xs text-muted">Jordan M.</span>
              </div>
              <p className="mt-2 text-sm text-offwhite/90">
                Best fade I&apos;ve gotten in years. In and out, super clean.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-subtle">
            {reviews.map((r) => (
              <li key={r.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Stars value={r.rating} />
                      <span className="text-xs font-medium text-muted">
                        {r.authorName || "Anonymous"}
                      </span>
                    </div>
                    {r.body && (
                      <p className="mt-1.5 text-sm text-offwhite/90">{r.body}</p>
                    )}
                    <p className="mt-1.5 text-[11px] text-muted/70">
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <ReviewModeration id={r.id} status={r.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
