import { apiEnv, randomToken } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Shop photo storage on Supabase Storage, via its plain REST API (no SDK, no
 * extra dependency). Uploads land in a PUBLIC bucket so the returned URL renders
 * directly on the public shop page.
 *
 * Optional by design: if the Supabase env vars aren't set, isStorageConfigured()
 * is false and callers return 503 + the editor falls back to paste-a-URL. The
 * app boots and works without any storage configured.
 */

/** Image MIME types we accept (and their canonical file extensions). */
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Hard ceiling per upload. The editor downscales before sending, so this is a backstop. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

/** Photo "slot" on the page - only used to organize the storage path. */
export type UploadKind = "logo" | "hero" | "gallery";
const KINDS: readonly UploadKind[] = ["logo", "hero", "gallery"];

export function isUploadKind(v: unknown): v is UploadKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

export function isAllowedContentType(ct: string): boolean {
  return ct in ALLOWED;
}

export function isStorageConfigured(): boolean {
  const env = apiEnv();
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export interface UploadResult {
  url: string;
  path: string;
}

/**
 * Upload raw image bytes to Supabase Storage. Returns the public URL.
 * Throws on a non-2xx storage response (the route maps that to a 502).
 */
export async function uploadShopImage(params: {
  shopId: string;
  kind: UploadKind;
  contentType: string;
  body: Buffer;
}): Promise<UploadResult> {
  const env = apiEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("storage_not_configured");
  }
  const ext = ALLOWED[params.contentType];
  if (!ext) throw new Error("unsupported_type");

  const bucket = env.SUPABASE_STORAGE_BUCKET;
  // Unguessable filename so one shop can't probe another's object paths, and
  // re-uploads never collide. Path is namespaced by shop + kind for easy ops.
  const objectPath = `shops/${params.shopId}/${params.kind}/${randomToken(12)}.${ext}`;
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const uploadUrl = `${base}/storage/v1/object/${bucket}/${objectPath}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": params.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      // Object paths are random, so a collision means a retry of the same upload.
      "x-upsert": "true",
    },
    body: params.body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.error(
      { status: res.status, detail: detail.slice(0, 500), bucket },
      "supabase storage upload failed",
    );
    throw new Error("storage_upload_failed");
  }

  // Public bucket URL. (If the bucket is private this resolves but 400s on GET -
  // the bucket MUST be public; see the setup notes.)
  const url = `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
  return { url, path: objectPath };
}
