"use client";

import { useCallback, useState } from "react";

/**
 * Client-side image upload for the page editor. Downscales big phone photos in
 * the browser (canvas) before sending - keeps quality high but file sizes sane,
 * and means a 12MP photo doesn't blow the 8MB server cap. POSTs to the same-origin
 * Next route handler (/api/page/upload), which proxies to the API + storage.
 *
 * If storage isn't configured server-side, the POST returns 503 and `error`
 * surfaces "uploads_unavailable" so the caller can nudge the user to paste a URL.
 */

export type UploadKind = "logo" | "hero" | "gallery" | "avatar" | "service";

const ACCEPT = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// Longest edge after downscale. Generous (retina-sharp) but bounded.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.86;

export interface UploadState {
  uploading: boolean;
  error: string | null;
}

/** Downscale to <= MAX_EDGE on the long edge and re-encode. GIFs pass through
 *  untouched (canvas would flatten animation); they're size-checked server-side. */
async function prepare(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // decode failed - let the server validate the raw file
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return file; // already small enough; send as-is (no quality loss)
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  return blob ?? file;
}

function messageFor(error: string): string {
  switch (error) {
    case "uploads_unavailable":
      return "Photo uploads aren't set up yet. Paste an image URL instead.";
    case "unsupported_type":
      return "Use a JPG, PNG, WebP, or GIF image.";
    case "bad_size":
    case "http_413":
      return "That image is too large. Try a smaller one.";
    case "unauthorized":
    case "http_401":
      return "Your session expired. Refresh and try again.";
    default:
      return "Upload failed. Try again or paste a URL.";
  }
}

export function useImageUpload(kind: UploadKind) {
  const [state, setState] = useState<UploadState>({ uploading: false, error: null });

  const upload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!ACCEPT.includes(file.type)) {
        setState({ uploading: false, error: messageFor("unsupported_type") });
        return null;
      }
      setState({ uploading: true, error: null });
      try {
        const blob = await prepare(file);
        const form = new FormData();
        // Name the part "file"; the route handler reads form.get("file").
        const name = file.name || "photo";
        form.append("file", blob, name);
        const res = await fetch(`/api/page/upload?kind=${kind}`, {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) {
          setState({ uploading: false, error: messageFor(data.error ?? `http_${res.status}`) });
          return null;
        }
        setState({ uploading: false, error: null });
        return data.url;
      } catch {
        setState({ uploading: false, error: messageFor("network") });
        return null;
      }
    },
    [kind],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, upload, clearError, accept: ACCEPT.join(",") };
}
