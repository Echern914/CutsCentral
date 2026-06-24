import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser -> Next -> Express bridge for push UNSUBSCRIBE. Same public,
 * magicToken-keyed, cookie-less relay as the subscribe route - see that file for
 * why the proxy exists (CSP connect-src 'self').
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export async function POST(
  req: NextRequest,
  { params }: { params: { magicToken: string } },
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const res = await fetch(
    `${API_BASE}/api/rewards/${encodeURIComponent(params.magicToken)}/push-unsubscribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  ).catch(() => null);

  if (!res) {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }
  const data = await res.json().catch(() => ({ error: `http_${res.status}` }));
  return NextResponse.json(data, { status: res.status });
}
