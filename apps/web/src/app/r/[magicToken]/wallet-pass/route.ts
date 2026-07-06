import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser -> Next -> Express bridge for the Apple Wallet pass download, the
 * same same-origin relay as push/subscribe (the CSP blocks direct browser
 * fetches to the API origin, and Safari needs a plain same-tab navigation to
 * present the Add-to-Wallet sheet). Public magicToken-keyed path: the token in
 * the URL is the auth; we just stream the signed .pkpass back with its
 * content type intact.
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export async function GET(
  _req: NextRequest,
  { params }: { params: { magicToken: string } },
): Promise<NextResponse> {
  const res = await fetch(
    `${API_BASE}/api/rewards/${encodeURIComponent(params.magicToken)}/wallet-pass`,
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
      "Content-Disposition": 'attachment; filename="punchcard.pkpass"',
      "Cache-Control": "no-store",
    },
  });
}
