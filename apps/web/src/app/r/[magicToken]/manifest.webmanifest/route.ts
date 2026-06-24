import { NextResponse } from "next/server";
import { apiPublicGet } from "@/lib/api";
import { resolveRewardsTheme } from "../theme";
import type { RewardsData } from "../page";

/**
 * Per-shop Web App Manifest for the rewards PWA. A single static manifest can't
 * carry each barber's identity, so this resolves the shop by the customer's
 * magicToken and returns a manifest branded for THAT shop: their name as the app
 * title, their theme color, and a start_url/scope locked to this customer's own
 * rewards page. Linked from page.tsx generateMetadata.
 *
 * Public + no-cookie like the rewards GET it reuses. 404 on a bad token, so a
 * probe can't enumerate. Icons are generic app PNGs in /public for v1 (per-shop
 * glyphs would need server-side image processing of the barber's logo URL); the
 * shop branding still comes through via name + theme_color + the splash screen.
 */
export async function GET(
  _req: Request,
  { params }: { params: { magicToken: string } },
): Promise<NextResponse> {
  const token = params.magicToken;
  const res = await apiPublicGet<RewardsData>(`/api/rewards/${token}`);
  if (!res.ok || !res.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { shop } = res.data;
  const theme = resolveRewardsTheme(shop);
  const start = `/r/${token}?source=pwa`;

  const manifest = {
    name: `${shop.name} Rewards`,
    short_name: shop.name.slice(0, 12),
    description: `Your loyalty rewards at ${shop.name}.`,
    start_url: start,
    scope: `/r/${token}`,
    display: "standalone",
    orientation: "portrait",
    background_color: theme.bg,
    theme_color: theme.bg,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };

  return new NextResponse(JSON.stringify(manifest), {
    status: 200,
    headers: {
      "Content-Type": "application/manifest+json",
      // Short cache: the shop name/theme rarely change, but keep it fresh enough
      // that a rebrand shows up within minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
