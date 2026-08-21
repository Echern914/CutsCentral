import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The web app's first test runner.
 *
 * jsdom + Testing Library rather than logic-only tests, because the defects
 * this codebase actually ships are RENDER defects: a field whose unit vanished
 * the moment you typed, a chip that measured 959px, a feature built and never
 * mounted. Those all compile, and a pure unit test never sees them. Asserting
 * on the rendered output is the cheapest thing that would have caught any of
 * them.
 *
 * `fileURLToPath(import.meta.url)` takes a STRING deliberately: passing a URL
 * object trips a clash between the DOM lib's URL and @types/node's under this
 * tsconfig, and vitest.config.ts is inside the typecheck's include glob.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json so tests import modules by
    // the same specifier the app does.
    alias: { "@": resolve(here, "src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
