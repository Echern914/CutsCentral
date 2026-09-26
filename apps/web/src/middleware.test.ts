// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ATTRIBUTION_COOKIE, middleware } from "./middleware";

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
  it("🔴 rewrites to the resolver with the visitor's query intact and the path carried", () => {
    const r = rewriteOf(
      middleware(request("https://drickcuttinup.com/book?utm_source=ig&utm_medium=social&fbclid=PAZ")),
    )!;
    expect(r.pathname).toBe("/from-domain/drickcuttinup.com");
    expect(r.searchParams.get("utm_source")).toBe("ig");
    expect(r.searchParams.get("utm_medium")).toBe("social");
    expect(r.searchParams.get("fbclid")).toBe("PAZ");
    expect(r.searchParams.get("__cb_path")).toBe("/book");
  });

  it("a visitor cannot choose the carried path - the real one always wins", () => {
    const r = rewriteOf(middleware(request("https://drickcuttinup.com/?__cb_path=%2F%2Fevil.example")))!;
    expect(r.searchParams.getAll("__cb_path")).toEqual(["/"]);
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
