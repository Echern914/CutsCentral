import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // DB-backed tests run serially against one test database.
    fileParallelism: false,
    // Supabase pooled connection + cold start can be slow on first hit.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
