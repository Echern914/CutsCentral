import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
// SAFE is IMPORTED, never re-declared: a copy here would drift from the real
// list and quietly stop testing the routes that matter.
import { maskPathByPrefix, maskPathByRoute, REDACTED, SAFE_PARAMS as SAFE } from "./logRedaction.js";

/**
 * THE FORCING FUNCTION.
 *
 * Route-pattern masking is default-safe by construction: an unrecognised
 * parameter name is masked, so a `/:token` route written tomorrow is covered
 * the day it is written.
 *
 * The PREFIX fallback is not - it is a list, and lists rot. It only runs when
 * Express could not say which route matched (a body-parser failure, an
 * oversized payload), but that is precisely the case where the URL still holds
 * the credential.
 *
 * So this walks the REAL Express router table, finds every registered route
 * that declares a parameter the safe-list does not cover, and asserts the
 * fallback masks it. Add a tokenized route without extending the fallback and
 * this fails, by name, with the path it found.
 *
 * The router-table walk uses Express internals and lives ONLY in a test, so
 * if a future Express changes their shape it breaks CI rather than production
 * logging. If the walk ever finds nothing, that is treated as a failure too -
 * a silently empty sweep would assert nothing while looking green.
 */

interface Registered {
  fullPath: string;
  params: string[];
}

/** Recover a mounted router's prefix from its layer regexp. */
function prefixFromLayer(layer: { regexp?: RegExp & { fast_slash?: boolean } }): string {
  const re = layer.regexp;
  if (!re || re.fast_slash) return "";
  // Express builds `^\/api\/book\/?(?=\/|$)` for `app.use("/api/book", ...)`.
  const m = /^\^((?:\\\/[^\\?(]+)+)/.exec(re.source);
  if (!m) return "";
  return m[1]!.replace(/\\\//g, "/");
}

function collectRoutes(app: ReturnType<typeof createApp>): Registered[] {
  const out: Registered[] = [];
  const root = (app as unknown as { _router?: { stack?: unknown[] } })._router;
  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        name?: string;
        route?: { path?: string | string[] };
        handle?: { stack?: unknown[] };
        regexp?: RegExp & { fast_slash?: boolean };
      };
      if (layer.route?.path) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const rp of paths) {
          const full = `${prefix}${rp}`.replace(/\/{2,}/g, "/");
          const params = [...full.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
          out.push({ fullPath: full, params });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixFromLayer(layer));
      }
    }
  };
  walk(root?.stack ?? [], "");
  return out;
}

describe("every tokenized route is covered by the fallback too", () => {
  const app = createApp();
  const routes = collectRoutes(app);

  it("actually found the router table", () => {
    // A silently empty walk would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.some((r) => r.fullPath.includes("/offer/:token"))).toBe(true);
  });

  it("masks every non-safe route parameter WITHOUT a route pattern", () => {
    const uncovered: string[] = [];
    for (const route of routes) {
      const secrets = route.params.filter((p) => !SAFE.has(p));
      if (secrets.length === 0) continue;

      // Build a concrete URL, substituting a recognisable value per parameter.
      let concrete = route.fullPath;
      for (const p of route.params) {
        concrete = concrete.replace(`:${p}`, SAFE.has(p) ? `safe_${p}` : `SECRET_${p}_VALUE`);
      }
      const masked = maskPathByPrefix(concrete);
      if (secrets.some((p) => masked.includes(`SECRET_${p}_VALUE`))) {
        uncovered.push(`${route.fullPath}  ->  ${masked}`);
      }
    }
    expect(
      uncovered,
      `These routes carry a credential in the path but the prefix fallback does not mask it. ` +
        `Add the prefix to SECRET_PATH_PREFIXES (or SECRET_TRAILING_PREFIXES) in logRedaction.ts:\n` +
        uncovered.join("\n"),
    ).toEqual([]);
  });

  it("masks every non-safe route parameter WITH the route pattern", () => {
    // The primary path, asserted over the real table rather than a sample.
    for (const route of routes) {
      const secrets = route.params.filter((p) => !SAFE.has(p));
      if (secrets.length === 0) continue;
      let concrete = route.fullPath;
      for (const p of route.params) {
        concrete = concrete.replace(`:${p}`, SAFE.has(p) ? `safe_${p}` : `SECRET_${p}_VALUE`);
      }
      const masked = maskPathByRoute(concrete, route.fullPath);
      for (const p of secrets) {
        expect(masked, `${route.fullPath} leaked :${p}`).not.toContain(`SECRET_${p}_VALUE`);
      }
      expect(masked).toContain(REDACTED);
    }
  });
});
