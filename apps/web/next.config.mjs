// CSP: Next.js needs inline scripts/styles for hydration without a nonce
// pipeline, so script/style allow 'unsafe-inline'. 'unsafe-eval' is only
// required by the dev-mode toolchain (react-refresh), never in production.
// Everything else is locked down; img allows https (shop logos are
// barber-provided URLs).
const isDev = process.env.NODE_ENV === "development";
// Stripe.js (the pay-ahead Payment Element on /book/[slug]) needs three
// allowances per Stripe's own CSP guidance: its script from js.stripe.com,
// its iframes (js.stripe.com + hooks.stripe.com), and API calls to
// api.stripe.com. Without these the payment step dies silently - the script
// tag loadStripe injects is cross-origin and script-src 'self' blocks it.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://js.stripe.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  // connect-src: same-origin for the app itself (push subscribe etc. go through
  // same-origin Next route handlers) + Stripe's API for the Payment Element.
  "connect-src 'self' https://api.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
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
  // /pricing is what people type and what ads link to, but pricing lives as a
  // homepage section. A config redirect (edge-level, proper Location header)
  // replaces the old static page calling redirect() - Vercel served that
  // prerendered 307 WITHOUT a Location header, which only script-running
  // browsers could recover from (crawlers and curl saw a broken redirect).
  async redirects() {
    return [{ source: "/pricing", destination: "/#pricing", permanent: false }];
  },
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
