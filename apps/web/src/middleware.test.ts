// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ATTRIBUTION_COOKIE, middleware } from "./middleware";
import { PATH_HEADER } from "./lib/customDomainGuard";

/**
 * The middleware on a shop's OWN domain - the path a customer takes when they
 * tap that domain in an Instagram bio - and proof that the platform's own
 * hosts behave exactly as before.
 *
 * Instagram hands a bare domain in a bio to its in-app browser as
 * http://<domain>/?utm_source=ig&... . Vercel upgrades that to https (one hop,
 * before any of this runs); from there the shop's page is served right here,
 * with no second hop off to another domain.
 */

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  const u = new URL(url);
  return new NextRequest(u, { headers: { host: u.host, ...headers } });
}

const rewriteOf = (res: Response): URL | null => {
  const to = res.headers.get("x-middleware-rewrite");
  return to ? new URL(to) : null;
};

const IG = "utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZ";

describe("a shop's own domain: the page", () => {
  it("🔴 serves the shop's page ON the domain - no redirect off it, Instagram's query intact", () => {
    const res = middleware(request(`https://studioone.com/?${IG}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const r = rewriteOf(res)!;
    expect(r.pathname).toBe("/custom-domain/studioone.com");
    expect(r.search).toBe(`?${IG}`);
  });

  it("/s/<anything> on the domain is still this domain's page", () => {
    for (const path of ["/s/studio-one", "/s/some-other-shop"]) {
      expect(rewriteOf(middleware(request(`https://studioone.com${path}`)))!.pathname, path).toBe(
        "/custom-domain/studioone.com",
      );
    }
  });

  it("www goes to the apex in one permanent hop, path and query kept", () => {
    const res = middleware(request(`https://www.studioone.com/book?service=svc_1&${IG}`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://studioone.com/book?service=svc_1&${IG}`);
  });

  it("case, a port and the root dot in the Host header all land on the same domain", () => {
    for (const host of ["StudioOne.COM", "studioone.com:443", "studioone.com."]) {
      const res = middleware(request("https://studioone.com/", { host }));
      expect(rewriteOf(res)!.pathname, host).toBe("/custom-domain/studioone.com");
    }
  });

  it("the router's own fetches for the page are served as usual", () => {
    const res = middleware(request("https://studioone.com/", { "sec-fetch-dest": "empty" }));
    expect(rewriteOf(res)!.pathname).toBe("/custom-domain/studioone.com");
  });

  it("a Host that is not a hostname gets nothing served under it", () => {
    const res = middleware(request("https://studioone.com/", { host: "bad_host!" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://getchairback.com/");
  });
});

describe("a shop's own domain: booking", () => {
  it("🔴 goes to the resolver, with the visitor's query intact and the path carried in a header", () => {
    const res = middleware(request(`https://studioone.com/book?service=svc_1&${IG}`));
    const r = rewriteOf(res)!;
    expect(r.pathname).toBe("/from-domain/studioone.com");
    expect(r.searchParams.get("service")).toBe("svc_1");
    expect(r.searchParams.get("fbclid")).toBe("PAZ");
    // The path is a REQUEST HEADER override, not a query parameter: a query
    // parameter added here never reached the route under `next start`.
    expect([...r.searchParams.keys()].sort()).toEqual(
      ["fbclid", "service", "utm_content", "utm_medium", "utm_source"].sort(),
    );
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/book");
    expect(res.headers.get("x-middleware-override-headers")).toContain(PATH_HEADER);
  });

  it("every booking spelling goes the same way", () => {
    for (const path of ["/book/studio-one", "/BOOK/Studio-One", "/book/studio-one/group", "/book/some-other-shop"]) {
      const res = middleware(request(`https://studioone.com${path}`));
      expect(rewriteOf(res)!.pathname, path).toBe("/from-domain/studioone.com");
      expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`), path).toBe(path);
    }
  });

  it("a visitor cannot choose the carried path - the real one always wins", () => {
    const res = middleware(request("https://studioone.com/book", { [PATH_HEADER]: "//evil.example" }));
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/book");
  });
});

describe("a shop's own domain: everything else", () => {
  it("goes to the platform at the same path - temporarily", () => {
    const cases: [string, string][] = [
      // A redirect-based payment returns to the manage page with its params.
      [
        "https://studioone.com/book/manage/tok_1?payment_intent=pi_1&redirect_status=succeeded",
        "https://getchairback.com/book/manage/tok_1?payment_intent=pi_1&redirect_status=succeeded",
      ],
      ["https://studioone.com/my-rewards", "https://getchairback.com/my-rewards"],
      ["https://studioone.com/privacy", "https://getchairback.com/privacy"],
    ];
    for (const [from, to] of cases) {
      const res = middleware(request(from));
      expect(res.status, from).toBe(307);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  it("🔴 the router's own fetch for a page off the domain is NOT sent cross-origin", () => {
    // A <Link> prefetch or client navigation. Redirecting it would make the
    // browser fetch getchairback.com from the shop's domain, which the CSP
    // forbids. A non-flight answer turns the tap into an ordinary navigation,
    // and THAT one takes the redirect.
    //
    // Only the headers middleware really receives: Next strips `RSC` and
    // `Next-Router-*` before middleware runs, so a test that sent those would
    // pass while production never saw them.
    for (const path of ["/privacy", "/book"]) {
      const res = middleware(request(`https://studioone.com${path}`, { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }));
      expect(res.status, path).toBe(204);
      expect(res.headers.get("location"), path).toBeNull();
      expect(rewriteOf(res), path).toBeNull();
    }
    const doc = middleware(
      request("https://studioone.com/privacy", { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }),
    );
    expect(doc.status).toBe(307);
    expect(doc.headers.get("location")).toBe("https://getchairback.com/privacy");
    // A client without Sec-Fetch headers (a crawler, an older browser) is
    // still redirected.
    expect(middleware(request("https://studioone.com/privacy")).status).toBe(307);
  });

  it("🔴 never renders sign-in on a shop's domain - gated paths go to the platform", () => {
    const res = middleware(request("https://studioone.com/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://getchairback.com/dashboard");
  });

  it("records no attribution cookie there - only platform signup reads it", () => {
    const res = middleware(request(`https://studioone.com/?${IG}`));
    expect(res.cookies.get(ATTRIBUTION_COOKIE)).toBeUndefined();
  });
});

describe("the platform's own hosts, unchanged", () => {
  it("pass straight through and still record first-touch attribution", () => {
    const res = middleware(request("https://getchairback.com/s/studio-one?utm_source=ig"));
    expect(rewriteOf(res)).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.cookies.get(ATTRIBUTION_COOKIE)?.value).toContain('"utm_source":"ig"');
    // The root dot is still the platform, not somebody's custom domain.
    const dotted = middleware(request("https://getchairback.com/s/studio-one", { host: "getchairback.com." }));
    expect(dotted.headers.get("x-middleware-next")).toBe("1");
  });

  it("still gate the dashboard", () => {
    const res = middleware(request("https://getchairback.com/dashboard"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("do not expose the internal routes a shop's domain is served through", () => {
    for (const path of ["/custom-domain/studioone.com", "/custom-domain", "/from-domain/studioone.com"]) {
      expect(middleware(request(`https://getchairback.com${path}`)).status, path).toBe(404);
    }
  });
});
