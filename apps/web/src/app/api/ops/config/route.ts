import { NextResponse } from "next/server";

/**
 * What the WEB deployment can and cannot do, as booleans.
 *
 * 🔴 WHY THIS HAS TO EXIST. The operator preflight (`GET /preflight` on the
 * API) reports "which integrations are live on this deployment" and is good at
 * it - but it runs in the API process on Railway and reads Railway's
 * environment. Analytics, the Android fingerprint and the store links live in
 * VERCEL's environment, and the NEXT_PUBLIC_* ones are inlined at build time.
 * The API cannot see any of them, at all, ever.
 *
 * That is the structural reason PostHog, Meta Pixel, web-push opt-in and the
 * app banner sat dark in production for months with a perfectly healthy
 * preflight: the check could only see half the system. This endpoint is the
 * other half, so one report can cover the whole deployment.
 *
 * 🔴 BOOLEANS ONLY. Never echo a key, an id or a fingerprint. Whether a pixel
 * is configured is operational; the pixel id is not ours to hand out, and this
 * response would be the easiest place in the product to leak one.
 *
 * Authenticated with WEB_PROXY_SECRET, the shared secret both apps already
 * hold (the web sends it to the API today on x-cb-proxy-secret when forwarding
 * a visitor IP). Unset on either side => 404, not 401: an unauthenticated
 * caller should not learn that this route exists.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.WEB_PROXY_SECRET;
  const offered = request.headers.get("x-cb-proxy-secret");
  if (!secret || offered !== secret) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    // Product analytics. Absent => `track()` silently no-ops and every
    // conversion number is zero by omission rather than by behavior.
    posthog: Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
    metaPixel: Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID),
    // Web push opt-in on the rewards page. The API holds the PRIVATE half and
    // checks it separately; without the public key here the UI never appears,
    // so both halves have to be true for push to actually be offerable.
    pushPublicKey: Boolean(process.env.PUSH_VAPID_PUBLIC_KEY),
    // Android App Links. Empty is CORRECT until an Android build exists - a
    // wrong fingerprint is worse than none, because Android caches the failed
    // verification. Reported so the state is visible, not to nag.
    androidAppLinks: Boolean(process.env.ANDROID_CERT_SHA256_FINGERPRINT),
  });
}
