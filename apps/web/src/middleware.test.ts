// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ATTRIBUTION_COOKIE, middleware } from "./middleware";
import { PATH_HEADER } from "./lib/customDomainGuard";

/**
 * The middleware's one change for custom domains: the visitor's own query now
 * rides along to the resolver (it used to be wiped - and with it the only
 * record that the visit came from an Instagram bio). Everything on the
 * platform's own hosts is pinned as unchanged.
 */

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  const u = new URL(url);
  return new NextRequest(u, { headers: { host: u.host, ...headers } });
}

const rewriteOf = (res: Response): URL | null => {
  const to = res.headers.get("x-middleware-rewrite");
  return to ? new URL(to) : null;
};

describe("a shop's own domain", () => {
  it("🔴 rewrites to the resolver with the visitor's query intact and the path carried in a header", () => {
    const res = middleware(request("https://drickcuttinup.com/book?utm_source=ig&utm_medium=social&fbclid=PAZ"));
    const r = rewriteOf(res)!;
    expect(r.pathname).toBe("/from-domain/drickcuttinup.com");
    expect(r.searchParams.get("utm_source")).toBe("ig");
    expect(r.searchParams.get("utm_medium")).toBe("social");
    expect(r.searchParams.get("fbclid")).toBe("PAZ");
    // The path is a REQUEST HEADER override, not a query parameter: a query
    // parameter added here never reached the route under `next start`.
    expect([...r.searchParams.keys()].sort()).toEqual(["fbclid", "utm_medium", "utm_source"]);
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/book");
    expect(res.headers.get("x-middleware-override-headers")).toContain(PATH_HEADER);
  });

  it("a visitor cannot choose the carried path - the real one always wins", () => {
    const res = middleware(request("https://drickcuttinup.com/", { [PATH_HEADER]: "//evil.example" }));
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/");
  });

  it("a port in the Host header is not part of the name", () => {
    const r = rewriteOf(middleware(request("https://drickcuttinup.com:443/")))!;
    expect(r.pathname).toBe("/from-domain/drickcuttinup.com");
  });
});

describe("the platform's own hosts, unchanged", () => {
  it("pass straight through and still record first-touch attribution", () => {
    const res = middleware(request("https://getchairback.com/s/drickcuttinup?utm_source=ig"));
    expect(rewriteOf(res)).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ATTRIBUTION_COOKIE)?.value).toContain('"utm_source":"ig"');
  });

  it("still gate the dashboard", () => {
    const res = middleware(request("https://getchairback.com/dashboard"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
