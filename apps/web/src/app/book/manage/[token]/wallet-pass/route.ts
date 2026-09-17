import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser -> Next -> Express bridge for the APPOINTMENT Wallet pass, the twin
 * of the punch card's relay at /r/[magicToken]/wallet-pass and for the same two
 * reasons: the CSP blocks direct browser fetches to the API origin, and Safari
 * only presents the Add-to-Wallet sheet for a plain same-tab navigation.
 *
 * The manageToken in the URL is the auth — the same no-login trust model the
 * cancel/reschedule page runs on. We add nothing to it and just stream the
 * signed .pkpass back with its content type intact.
 *
 * A 404 here is the ordinary case for a booking that has been canceled, and a
 * 503 is the pass type not being configured yet; both are passed through rather
 * than dressed up, because the badge that links here is already hidden unless
 * the payload said the pass was available.
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const res = await fetch(
    `${API_BASE}/api/book/manage/${encodeURIComponent(params.token)}/wallet-pass`,
    { cache: "no-store" },
  ).catch(() => null);

  if (!res) {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: `http_${res.status}` }, { status: res.status });
  }
  const pass = await res.arrayBuffer();
  return new NextResponse(pass, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": 'attachment; filename="appointment.pkpass"',
      "Cache-Control": "no-store",
    },
  });
}
