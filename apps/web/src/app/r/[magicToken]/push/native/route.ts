import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser/App -> Next -> Express bridge for NATIVE (Expo) push registration. The
 * native app POSTs its Expo push token here (same origin), and we forward it to
 * the public Express rewards endpoint. Same public, magicToken-keyed, cookie-less
 * relay as the web push subscribe route - see that file for the CSP rationale.
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
    `${API_BASE}/api/rewards/${encodeURIComponent(params.magicToken)}/push-native`,
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
