import { defineConfig } from "vitest/config";

/**
 * The mobile app's first test runner.
 *
 * Deliberately node-only and scoped to plain `.ts` under src/: this app is React
 * Native, and standing up a full RN render harness (a Metro/babel transform plus
 * a renderer) to assert a button exists would be a large, fragile dependency for
 * very little. Instead the DECISIONS worth protecting are kept in pure modules
 * with no react-native import - src/mode.ts is the first - and those are tested
 * properly here. Screens stay thin wiring over them.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
