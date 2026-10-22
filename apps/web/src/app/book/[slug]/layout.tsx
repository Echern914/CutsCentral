import type { ReactNode } from "react";
import { apiPublicGet } from "@/lib/api";
import { PAGE_DARK_PREPAINT_SCRIPT } from "@/lib/theme";
import { PageScheme } from "@/components/PageScheme";
import { bookingScheme } from "./pageScheme";

// The shop page caches its own payload for 60s; the scheme is read from the
// same cached copy, so this costs no extra API round trip per visit.
const PAGE_REVALIDATE_S = 60;

/**
 * The booking pages (single and group) wear the colours of the shop's own
 * page - see pageScheme.ts. A dark shop paints <html> dark before first paint.
 */
export default async function BookLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { slug: string };
}) {
  const res = await apiPublicGet<{ theme?: string | null }>(
    `/api/page/${encodeURIComponent(params.slug)}`,
    PAGE_REVALIDATE_S,
  ).catch(() => null);
  const scheme = bookingScheme(res?.ok && res.data ? res.data : null);
  return (
    <>
      {scheme === "dark" && <script dangerouslySetInnerHTML={{ __html: PAGE_DARK_PREPAINT_SCRIPT }} />}
      <PageScheme scheme={scheme} />
      {children}
    </>
  );
}
