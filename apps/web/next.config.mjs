// CSP: Next.js needs inline scripts/styles for hydration without a nonce
// pipeline, so script/style allow 'unsafe-inline'. 'unsafe-eval' is only
// required by the dev-mode toolchain (react-refresh), never in production.
// Everything else is locked down; img allows https (shop logos are
// barber-provided URLs).
const isDev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  // connect-src stays 'self': push subscribe/unsubscribe go to same-origin Next
  // route handlers (which forward to the API server-side), and push DELIVERY is
  // an OS channel, not a page fetch - so no API origin is needed here.
  "connect-src 'self'",
  // The rewards PWA service worker (public/sw.js, same origin).
  "worker-src 'self'",
  // The per-shop dynamic manifest route (same origin).
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the shared workspace package from source.
  transpilePackages: ["@chairback/config"],
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Never let a stale service worker stick around behind a CDN: the SW is the
      // update mechanism for the PWA, so it must always revalidate.
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
  // On Vercel (monorepo, "include files outside root" on), `next build` can pull
  // sibling workspace TS (apps/api) into its typecheck and fail on Node-vs-DOM
  // Response types that are valid in their own package. The web app's own types
  // are verified separately (pnpm --filter @chairback/web typecheck), so don't
  // let the cross-package typecheck block the build.
  typescript: { ignoreBuildErrors: true },
  webpack(config) {
    // The shared TS package uses NodeNext-style ".js" import specifiers that
    // point at ".ts" source. Map them so webpack resolves the source files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ...config.resolve.extensionAlias,
    };
    return config;
  },
};

export default nextConfig;
