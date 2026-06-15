import { Router, raw } from "express";
import { requireShop, requireUser } from "../middleware/auth.js";
import { uploadLimiter } from "../middleware/rateLimit.js";
import {
  MAX_UPLOAD_BYTES,
  isAllowedContentType,
  isStorageConfigured,
  isUploadKind,
  uploadShopImage,
} from "../services/storage.js";

/**
 * Photo upload for the public shop page (logo / hero / gallery). The browser
 * can't reach this origin directly (CSP connect-src 'self'), so the Next.js web
 * app proxies the file here as RAW bytes with the real image content-type. We
 * parse with express.raw() (not the global 100kb JSON parser) and stream to
 * Supabase Storage.
 *
 * Auth: requireUser + requireShop. shopId comes from the SESSION, never the body,
 * so a barber can only ever write under their own shop's storage path.
 */
export const uploadRouter: Router = Router();

uploadRouter.post(
  "/page/upload",
  uploadLimiter,
  requireUser,
  requireShop,
  // Accept any image/* content type up to the size cap. Reject too-large bodies
  // here (before buffering) with a clean 413.
  raw({ type: "image/*", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (!isStorageConfigured()) {
      res.status(503).json({ error: "uploads_unavailable" });
      return;
    }

    const kind = String(req.query.kind ?? "gallery");
    if (!isUploadKind(kind)) {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }

    const contentType = (req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!isAllowedContentType(contentType)) {
      res.status(415).json({ error: "unsupported_type" });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "empty_body" });
      return;
    }

    try {
      const { url } = await uploadShopImage({
        shopId: req.shop!.id,
        kind,
        contentType,
        body,
      });
      res.status(201).json({ url });
    } catch {
      res.status(502).json({ error: "upload_failed" });
    }
  },
);
