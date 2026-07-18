import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser -> Next -> Express upload bridge. The CSP (connect-src 'self') blocks a
 * direct browser fetch to the API origin, so the GalleryEditor POSTs a multipart
 * form HERE (same origin). We pull the file out and forward its RAW bytes to the
 * Express upload route, carrying the barber's session cookie for auth.
 *
 * Express derives shopId from that session - the client can't choose a shop -
 * so this thin proxy adds no trust surface beyond "is the user signed in".
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const MAX_BYTES = 8 * 1024 * 1024; // mirror the API cap for a clean early reject
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// Mirror UploadKind in apps/api/src/services/storage.ts (and useImageUpload.ts).
const KINDS = new Set(["logo", "hero", "gallery", "avatar"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const kind = req.nextUrl.searchParams.get("kind") ?? "gallery";
  if (!KINDS.has(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "bad_size" }, { status: 413 });
  }

  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const buf = Buffer.from(await file.arrayBuffer());
  const res = await fetch(
    `${API_BASE}/api/page/upload?kind=${encodeURIComponent(kind)}`,
    {
      method: "POST",
      headers: {
        "content-type": file.type,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: buf,
      cache: "no-store",
    },
  );

  // Pass the API's JSON + status straight through so the client sees real errors
  // (e.g. 503 uploads_unavailable when storage isn't configured).
  const data = await res.json().catch(() => ({ error: `http_${res.status}` }));
  return NextResponse.json(data, { status: res.status });
}
