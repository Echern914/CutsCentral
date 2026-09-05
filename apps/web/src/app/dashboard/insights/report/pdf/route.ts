import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

/**
 * The yearly report PDF, streamed through this same-origin route.
 *
 * A direct cross-origin `<a href>` to the API would not carry the httpOnly
 * session cookie, so the browser would be handed a 401 instead of a file. Same
 * shape as the CSV export next door.
 *
 * 🔴 THIS IS NOT A PUBLIC URL, AND MUST NEVER BECOME ONE. There is no token in
 * the path and nothing to guess: the report is produced only for whoever the
 * session says is asking, and the API applies the real rule (a barber may read
 * his own year, an owner the shop's or an authorised barber's, nobody another
 * shop's - see apps/api/src/routes/yearlyReport.ts). Every refusal is passed
 * through with its own status rather than being smoothed into an empty PDF,
 * which would look like "you have no numbers" rather than "you may not see
 * these".
 *
 * Nothing is cached anywhere. The file names real revenue for a named barber,
 * so a shared cache entry - a CDN, a proxy, the browser's own disk cache on a
 * shop's front-desk computer - is a disclosure waiting to happen.
 */
export const dynamic = "force-dynamic";

const ALLOWED_PAPER = new Set(["letter", "a4"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const year = url.searchParams.get("year");
  const subject = url.searchParams.get("subject");
  const paperRaw = url.searchParams.get("paper");
  const paper = paperRaw && ALLOWED_PAPER.has(paperRaw) ? paperRaw : "letter";
  // "download" only changes the Content-Disposition; the bytes are identical,
  // so a preview and the saved file can never be different documents.
  const download = url.searchParams.get("download") === "1";

  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const qs = new URLSearchParams({ paper });
  if (year) qs.set("year", year);
  if (subject) qs.set("subject", subject);

  const res = await fetch(`${API_BASE}/api/yearly-report/pdf?${qs.toString()}`, {
    headers: { Cookie: cookieHeader },
    cache: "no-store",
  });

  if (!res.ok) {
    // Pass the API's classification straight through. 403 means "not your
    // report" and 404 "no such barber in your shop" - two different things a
    // caller may need to tell apart, and neither is a server error.
    return NextResponse.json({ error: "report_unavailable" }, { status: res.status });
  }

  const body = await res.arrayBuffer();
  // The API already chose a safe, ASCII, path-separator-free filename; echo it
  // rather than rebuilding one here, so the two can never disagree.
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "chairback-report.pdf";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
