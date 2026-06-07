/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the shared workspace package from source.
  transpilePackages: ["@chairback/config"],
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
