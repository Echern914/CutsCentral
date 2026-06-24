import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser/Service-Worker -> Next -> Express bridge for push SUBSCRIBE. The CSP
 * (connect-src 'self') blocks a direct browser fetch to the API origin, and a
 * service worker can't call a Next server action - so the subscribe POST lands
 * HERE (same origin) and we forward it to the public Express rewards endpoint.
 *
 * No cookie: this is the PUBLIC magicToken-keyed path (the token in the URL is
 * the auth, exactly like the rewards GET/opt-in). We add no trust surface - we
 * just relay the body and pass the API's status/JSON straight back.
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
    `${API_BASE}/api/rewards/${encodeURIComponent(params.magicToken)}/push-subscribe`,
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
