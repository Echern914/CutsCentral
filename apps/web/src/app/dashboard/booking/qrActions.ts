"use server";

import QRCode from "qrcode";

/**
 * The shop's booking QR code, rendered SERVER-side.
 *
 * Server, not client, for three reasons: no QR library ships to the browser
 * (this is a page a barber opens once, not something worth 20kB on every
 * dashboard load), the published-artifact CSP never has to allow a canvas
 * rasterizer, and the same call yields both the crisp vector for printing and
 * the bitmap for a Download button.
 *
 * ERROR CORRECTION IS DELIBERATELY HIGH ('H', ~30% recoverable). This code ends
 * up on a mirror, a window or a business card - somewhere it will be smudged,
 * curled, or half-lit. The cost is a denser grid; the benefit is that it still
 * scans after real-world abuse.
 */

/** Quiet zone in modules. 4 is the spec minimum; below it scanners miss. */
const QUIET_ZONE = 4;
/** Download size. 1024px stays sharp on a printed card without being huge. */
const PNG_WIDTH = 1024;

export interface ShopQr {
  /** Inline SVG markup - scales to any print size with no blur. */
  svg: string;
  /** data:image/png;base64 - what the Download button saves. */
  png: string;
  /** The URL encoded in the code, shown under it so it's verifiable by eye. */
  url: string;
}

/**
 * Build the code for one booking URL.
 *
 * The URL is passed in rather than derived here: the dashboard already computes
 * it (slug, and later a custom domain), and a QR that disagrees with the link
 * printed beside it would be the worst possible bug in this feature - you would
 * not find out until a client in a chair couldn't scan a sticker on a wall.
 */
export async function getShopQrAction(url: string): Promise<
  { ok: true; qr: ShopQr } | { ok: false; error: string }
> {
  const trimmed = url.trim();
  // Refuse anything that isn't an absolute http(s) URL. A relative path would
  // encode a code that scans to nothing on a phone.
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    return { ok: false, error: "invalid_url" };
  }
  try {
    const [svg, png] = await Promise.all([
      QRCode.toString(trimmed, {
        type: "svg",
        errorCorrectionLevel: "H",
        margin: QUIET_ZONE,
        color: { dark: "#000000", light: "#FFFFFF" },
      }),
      QRCode.toDataURL(trimmed, {
        errorCorrectionLevel: "H",
        margin: QUIET_ZONE,
        width: PNG_WIDTH,
        color: { dark: "#000000", light: "#FFFFFF" },
      }),
    ]);
    return { ok: true, qr: { svg, png, url: trimmed } };
  } catch {
    return { ok: false, error: "qr_failed" };
  }
}
