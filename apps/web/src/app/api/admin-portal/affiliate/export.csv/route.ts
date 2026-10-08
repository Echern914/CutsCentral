import { cookies } from "next/headers";

/**
 * Same-origin bridge for the admin Affiliates "Export CSV" link.
 *
 * The link is relative, so it resolves to the WEB origin, which had no such
 * route: the operator got a 404. The CSV lives on the API host, behind the
 * same admin session and IP gate as every other admin-portal read this
 * dashboard makes server-side. This forwards the visitor's cookies and hands
 * back the file; the API still decides who may have it.
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/api/admin-portal/affiliate/export.csv`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
    });
  } catch {
    return new Response("Export unavailable. Try again in a moment.", { status: 502 });
  }
  if (!upstream.ok) {
    return new Response("Export unavailable.", { status: upstream.status });
  }
  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "Content-Disposition":
        upstream.headers.get("content-disposition") ?? 'attachment; filename="affiliates.csv"',
      "Cache-Control": "no-store",
    },
  });
}
