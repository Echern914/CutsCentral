// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ATTRIBUTION_COOKIE, middleware } from "./middleware";

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
  it("🔴 is served ON the domain - no redirect off it, the visitor's query intact", () => {
    const res = middleware(request(`https://studioone.com/book?service=svc_1&${IG}`));
    expect(res.headers.get("location")).toBeNull();
    const r = rewriteOf(res)!;
    expect(r.pathname).toBe("/custom-domain/studioone.com/book");
    expect(r.searchParams.get("service")).toBe("svc_1");
    expect(r.searchParams.get("fbclid")).toBe("PAZ");
  });

  it("every booking spelling, and any slug, is this domain's booking", () => {
    const cases: [string, string][] = [
      ["/book/studio-one", "/custom-domain/studioone.com/book"],
      ["/BOOK/Studio-One", "/custom-domain/studioone.com/book"],
      ["/book/some-other-shop", "/custom-domain/studioone.com/book"],
      ["/book/studio-one/group", "/custom-domain/studioone.com/book/group"],
      ["/book/studio-one/assistant", "/custom-domain/studioone.com/book/assistant"],
    ];
    for (const [path, to] of cases) {
      expect(rewriteOf(middleware(request(`https://studioone.com${path}`)))!.pathname, path).toBe(to);
    }
  });

  it("🔴 the form's own fetches reach it - Confirm is a server action, a fetch like any other", () => {
    // These used to get the 204 below, which is right for a page off the
    // domain and fatal for one served on it.
    const res = middleware(
      request("https://studioone.com/book", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }),
    );
    expect(res.status).toBe(200);
    expect(rewriteOf(res)!.pathname).toBe("/custom-domain/studioone.com/book");
  });
});

describe("a shop's own domain: the booked screen and rewards", () => {
  it("🔴 are served ON the domain at their own path, query intact", () => {
    for (const path of [
      // A redirect-based payment returns to the manage page with its params.
      "/book/manage/tok_1?payment_intent=pi_1&redirect_status=succeeded",
      "/book/manage/tok_1/wallet-pass",
      "/book/group/tok_2",
      "/r/magic",
      "/r/magic/rewards",
      "/my-rewards",
    ]) {
      const res = middleware(request(`https://studioone.com${path}`));
      expect(res.headers.get("location"), path).toBeNull();
      expect(rewriteOf(res), path).toBeNull();
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("their fetches too - the rewards card's push opt-in posts to its own route", () => {
    const res = middleware(
      request("https://studioone.com/r/magic/push/subscribe", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("another spelling is served as the page's own, the token untouched", () => {
    const r = rewriteOf(middleware(request("https://studioone.com/Book/Manage/Tok_AbC")))!;
    expect(r.host).toBe("studioone.com");
    expect(r.pathname).toBe("/book/manage/Tok_AbC");
  });

  /** The visit path the PAGE is handed (Next forwards it as a request header). */
  const visitPathOf = (res: Response) => res.headers.get("x-middleware-request-x-cb-visit-path");

  it("🔴 hands the page its own path and query - the card's layout redirects from it", () => {
    expect(visitPathOf(middleware(request("https://studioone.com/r/magic?tip=1")))).toBe("/r/magic?tip=1");
    expect(visitPathOf(middleware(request("https://studioone.com/r/magic/rewards")))).toBe("/r/magic/rewards");
    // Under the spelling the page is served by, not the one typed.
    expect(visitPathOf(middleware(request("https://studioone.com/R/magic/Rewards")))).toBe("/r/magic/rewards");
  });

  it("🔴 replaces whatever the browser sent under that name", () => {
    const res = middleware(request("https://studioone.com/r/magic", { "x-cb-visit-path": "//evil.example/r/magic" }));
    expect(visitPathOf(res)).toBe("/r/magic");
  });
});

describe("a shop's own domain: everything else", () => {
  it("goes to the platform at the same path - temporarily", () => {
    const cases: [string, string][] = [
      ["https://studioone.com/privacy", "https://getchairback.com/privacy"],
      ["https://studioone.com/terms?x=1", "https://getchairback.com/terms?x=1"],
      ["https://studioone.com/waitlist/offer/tok", "https://getchairback.com/waitlist/offer/tok"],
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
    for (const path of ["/privacy", "/login"]) {
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

  it("🔴 never renders sign-in on a shop's domain - sign-in and gated paths go to the platform", () => {
    for (const path of ["/dashboard", "/login"]) {
      const res = middleware(request(`https://studioone.com${path}`));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toBe(`https://getchairback.com${path}`);
    }
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
    for (const path of ["/custom-domain/studioone.com", "/custom-domain", "/custom-domain/studioone.com/book"]) {
      expect(middleware(request(`https://getchairback.com${path}`)).status, path).toBe(404);
    }
  });
});

describe("the iOS app's way out to billing: /pricing?start=plan", () => {
  it("🔴 in Safari, becomes the plan cards on the billing page", () => {
    const res = middleware(request("https://getchairback.com/pricing?start=plan", { cookie: "cb_session=x" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://getchairback.com/dashboard/billing#plans");
  });

  it("signed out, the billing page then asks for a sign-in and comes back to it", () => {
    const res = middleware(request("https://getchairback.com/dashboard/billing"));
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/dashboard/billing");
  });

  it("plain /pricing is still the pricing page", () => {
    for (const url of ["https://getchairback.com/pricing", "https://getchairback.com/pricing?start=other"]) {
      const res = middleware(request(url));
      expect(res.headers.get("location"), url).toBeNull();
    }
  });
});

describe("the iOS app's way out to billing, signed in: /pricing?start=plan&h=<code>", () => {
  it("🔴 in Safari, a code goes to the signed-in landing, intact", () => {
    const res = middleware(request("https://getchairback.com/pricing?start=plan&h=abc.d%2Be"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/auth/billing/landing");
    expect(to.searchParams.get("code")).toBe("abc.d+e");
    expect(to.searchParams.get("start")).toBeNull();
  });

  it("an empty code is the same as none: straight to the plan cards", () => {
    const res = middleware(request("https://getchairback.com/pricing?start=plan&h="));
    expect(res.headers.get("location")).toBe("https://getchairback.com/dashboard/billing#plans");
  });
});
