// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

/**
 * The middleware on a shop's OWN domain - the path a customer takes when they
 * tap drickcuttinup.com in an Instagram bio - and proof that the platform's
 * own hosts behave exactly as before.
 *
 * Instagram hands a bare domain in a bio to its in-app browser as
 * http://<domain>/?utm_source=ig&... . Vercel upgrades that to https (one
 * hop, before any of this runs); from there the shop page must be served
 * right here, with no second hop off to another domain.
 */

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  const u = new URL(url);
  return new NextRequest(u, { headers: { host: u.host, ...headers } });
}

const rewriteTarget = (res: Response): string | null => {
  const to = res.headers.get("x-middleware-rewrite");
  if (!to) return null;
  const u = new URL(to);
  return `${u.pathname}${u.search}`;
};

describe("a shop's own domain", () => {
  it("🔴 serves the shop page ON the domain - no redirect off it", () => {
    const res = middleware(
      request(
        "https://drickcuttinup.com/?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZ",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(rewriteTarget(res)).toBe(
      "/custom-domain/drickcuttinup.com?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZ",
    );
  });

  it("serves booking on the domain, prefill intact", () => {
    expect(rewriteTarget(middleware(request("https://drickcuttinup.com/book")))).toBe(
      "/custom-domain/drickcuttinup.com/book",
    );
    expect(
      rewriteTarget(middleware(request("https://drickcuttinup.com/book/drickcuttinup?service=svc_1&staff=st_2"))),
    ).toBe("/custom-domain/drickcuttinup.com/book?service=svc_1&staff=st_2");
    expect(rewriteTarget(middleware(request("https://drickcuttinup.com/book/drickcuttinup/group")))).toBe(
      "/custom-domain/drickcuttinup.com/book/group",
    );
    // The booking page links back to the shop as /s/<slug>.
    expect(rewriteTarget(middleware(request("https://drickcuttinup.com/s/drickcuttinup")))).toBe(
      "/custom-domain/drickcuttinup.com",
    );
  });

  it("🔴 another shop's slug in the path cannot put that shop on this domain", () => {
    const to = rewriteTarget(middleware(request("https://drickcuttinup.com/book/some-other-shop")));
    expect(to).toBe("/custom-domain/drickcuttinup.com/book");
    expect(to).not.toContain("some-other-shop");
  });

  it("www goes to the apex in one permanent hop, path and query kept", () => {
    const res = middleware(request("https://www.drickcuttinup.com/book?service=svc_1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://drickcuttinup.com/book?service=svc_1");
  });

  it("case, a port and the root dot in the Host header all land on the same domain", () => {
    for (const host of ["DrickCuttinUp.COM", "drickcuttinup.com:443", "drickcuttinup.com."]) {
      const res = middleware(request("https://drickcuttinup.com/", { host }));
      expect(rewriteTarget(res), host).toBe("/custom-domain/drickcuttinup.com");
    }
  });

  it("hands everything else to the platform at the same path - temporarily", () => {
    const cases: [string, string][] = [
      // A redirect-based payment returns to the manage page with its params.
      [
        "https://drickcuttinup.com/book/manage/tok_1?payment_intent=pi_1&redirect_status=succeeded",
        "https://getchairback.com/book/manage/tok_1?payment_intent=pi_1&redirect_status=succeeded",
      ],
      ["https://drickcuttinup.com/my-rewards", "https://getchairback.com/my-rewards"],
      ["https://drickcuttinup.com/privacy", "https://getchairback.com/privacy"],
    ];
    for (const [from, to] of cases) {
      const res = middleware(request(from));
      expect(res.status, from).toBe(307);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  it("🔴 the router's own fetch for a platform page is NOT sent cross-origin", () => {
    // A <Link> prefetch of /privacy on the booking page. Redirecting it would
    // make the browser fetch getchairback.com from drickcuttinup.com, which
    // the CSP forbids. A non-flight answer turns the tap into an ordinary
    // navigation, and THAT one takes the redirect.
    //
    // Only the headers middleware really receives: Next strips `RSC` and
    // `Next-Router-*` before middleware runs, so a test that sent those would
    // pass while production never saw them - which is exactly how the first
    // version of this check shipped to a local build and did nothing.
    const fetchReq = middleware(
      request("https://drickcuttinup.com/privacy", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }),
    );
    expect(fetchReq.status).toBe(204);
    expect(fetchReq.headers.get("location")).toBeNull();
    const doc = middleware(
      request("https://drickcuttinup.com/privacy", { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }),
    );
    expect(doc.status).toBe(307);
    expect(doc.headers.get("location")).toBe("https://getchairback.com/privacy");
    // A client without Sec-Fetch headers (a crawler, an older browser) is
    // still redirected.
    expect(middleware(request("https://drickcuttinup.com/privacy")).status).toBe(307);
    // Pages served on the domain are still rendered for the router as usual.
    const page = middleware(
      request("https://drickcuttinup.com/book/drickcuttinup", { "sec-fetch-dest": "empty" }),
    );
    expect(rewriteTarget(page)).toBe("/custom-domain/drickcuttinup.com/book");
  });

  it("🔴 never renders sign-in on a barber's domain - gated paths go to the platform", () => {
    const res = middleware(request("https://drickcuttinup.com/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://getchairback.com/dashboard");
  });

  it("a Host that is not a hostname gets nothing served under it", () => {
    const res = middleware(request("https://drickcuttinup.com/", { host: "bad_host!" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://getchairback.com/");
  });
});

describe("the platform's own hosts", () => {
  it("pass straight through, as before", () => {
    const res = middleware(request("https://getchairback.com/s/drickcuttinup"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(rewriteTarget(res)).toBeNull();
    // The root dot is still the platform, not somebody's custom domain.
    const dotted = middleware(request("https://getchairback.com/s/drickcuttinup", { host: "getchairback.com." }));
    expect(dotted.headers.get("x-middleware-next")).toBe("1");
  });

  it("still gate the dashboard", () => {
    const res = middleware(request("https://getchairback.com/dashboard"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("do not expose the internal custom-domain routes", () => {
    for (const path of ["/custom-domain/drickcuttinup.com", "/custom-domain/drickcuttinup.com/book"]) {
      expect(middleware(request(`https://getchairback.com${path}`)).status, path).toBe(404);
    }
  });
});
