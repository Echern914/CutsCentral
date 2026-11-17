import { describe, expect, it } from "vitest";
import { customDomainRoute, linkOnThisSite, type CustomDomainRoute } from "./customDomainRouting";

/**
 * Where a path on a shop's own domain is served. The shop itself is never
 * decided here - see app/custom-domain/[host]/domainShop.tsx - which is why
 * nothing below ever reads a slug.
 */

const shop = (page: string): CustomDomainRoute => ({ kind: "shop", page } as CustomDomainRoute);
const served = (path: string): CustomDomainRoute => ({ kind: "served", path });
const platform: CustomDomainRoute = { kind: "platform" };

describe("customDomainRoute", () => {
  const cases: [string, CustomDomainRoute][] = [
    // What the bare domain in a bio link is for.
    ["/", shop("")],
    ["/s/studio-one", shop("")],
    ["/S/Studio-One", shop("")],
    // 🔴 Booking, under every spelling a link uses: served ON the domain.
    ["/book", shop("/book")],
    ["/book/studio-one", shop("/book")],
    ["/BOOK/Studio-One", shop("/book")],
    ["/book/studio-one/group", shop("/book/group")],
    ["/book/studio-one/assistant", shop("/book/assistant")],
    // 🔴 What the booked screen links to, and finding your rewards: served on
    // the domain at their own path. The token keeps its case.
    ["/book/manage/Tok_123", served("/book/manage/Tok_123")],
    ["/Book/Manage/Tok_123", served("/book/manage/Tok_123")],
    ["/book/manage/tok_123/wallet-pass", served("/book/manage/tok_123/wallet-pass")],
    ["/book/group/tok_456", served("/book/group/tok_456")],
    ["/r/Magic", served("/r/Magic")],
    ["/r/magic/rewards", served("/r/magic/rewards")],
    ["/r/magic/wallet-pass", served("/r/magic/wallet-pass")],
    ["/r/magic/push/subscribe", served("/r/magic/push/subscribe")],
    ["/r/magic/push/unsubscribe", served("/r/magic/push/unsubscribe")],
    ["/r/magic/push/native", served("/r/magic/push/native")],
    ["/my-rewards", served("/my-rewards")],
    // Sign-in and the barber's side never live on a customer's domain, and
    // ChairBack's own pages stay ChairBack's.
    ["/login", platform],
    ["/signup", platform],
    ["/dashboard", platform],
    ["/privacy", platform],
    ["/terms", platform],
    ["/waitlist/offer/tok", platform],
    // Nothing else is a page of the domain's.
    ["/book/manage", platform],
    ["/book/manage/tok/elsewhere", platform],
    ["/book/group/tok/extra", platform],
    ["/book/studio-one/somewhere", platform],
    ["/book/studio-one/constructor", platform],
    ["/book/studio-one/group/extra", platform],
    ["/r", platform],
    ["/r/magic/elsewhere", platform],
    ["/r/magic/push/elsewhere", platform],
    ["/my-rewards/extra", platform],
    ["/s/studio-one/extra", platform],
  ];
  it.each(cases)("%s", (path, route) => {
    expect(customDomainRoute(path)).toEqual(route);
  });

  it("🔴 a slug in the path changes nothing: any shop's /s or /book is still THIS domain's", () => {
    // The shop routes carry no slug at all - the page they lead to takes the
    // host alone - so a crafted /book/<other-shop> has nothing to reach.
    expect(customDomainRoute("/s/some-other-shop")).toEqual(customDomainRoute("/"));
    expect(customDomainRoute("/book/some-other-shop")).toEqual(customDomainRoute("/book"));
    expect(customDomainRoute("/book/some-other-shop/group")).toEqual(customDomainRoute("/book/studio-one/group"));
  });
});

describe("linkOnThisSite: a getchairback.com link the API built", () => {
  const card = "https://getchairback.com/r/Magic_1?x=1";

  it("🔴 on a shop's domain, opens the same page there - the client stays on the domain", () => {
    expect(linkOnThisSite(card, "drickcuttinup.com")).toBe("/r/Magic_1?x=1");
  });

  it("is untouched on ChairBack's own hosts", () => {
    for (const host of ["getchairback.com", "www.getchairback.com", "x.vercel.app", "localhost:3000"]) {
      expect(linkOnThisSite(card, host), host).toBe(card);
    }
  });

  it("leaves anything the domain does not serve, any other site, and nonsense alone", () => {
    expect(linkOnThisSite("https://getchairback.com/login", "drickcuttinup.com")).toBe("https://getchairback.com/login");
    expect(linkOnThisSite("https://elsewhere.example/r/x", "drickcuttinup.com")).toBe("https://elsewhere.example/r/x");
    expect(linkOnThisSite("not a url", "drickcuttinup.com")).toBe("not a url");
  });
});
