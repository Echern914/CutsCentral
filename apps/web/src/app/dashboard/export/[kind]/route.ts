import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

/**
 * Proxies a CSV download from the API, forwarding the session cookie. A direct
 * cross-origin <a href> to the API wouldn't carry the httpOnly cookie, so we
 * stream it through this same-origin route handler instead.
 */
export async function GET(
  _req: Request,
  { params }: { params: { kind: string } },
) {
  const kind = params.kind === "nudges" ? "nudges" : "clients";
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const res = await fetch(`${API_BASE}/api/dashboard/export/${kind}.csv`, {
    headers: { Cookie: cookieHeader },
    cache: "no-store",
  });

  if (!res.ok) {
    return NextResponse.json({ error: "export_failed" }, { status: res.status });
  }
  const body = await res.text();
  // UTF-8 BOM: without it, Excel on Windows opens the file as ANSI and names
  // like "José" come out garbled.
  return new NextResponse(String.fromCharCode(0xfeff) + body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}.csv"`,
    },
  });
}
