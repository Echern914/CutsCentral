import { describe, expect, it } from "vitest";
import { customDomainTarget } from "./customDomainRouting";

/**
 * Which page a path on a shop's own domain asks for. The shop itself is never
 * decided here - see lib/customDomain.ts - which is why nothing below ever
 * reads a slug.
 */

describe("customDomainTarget", () => {
  const cases: [string, ReturnType<typeof customDomainTarget>][] = [
    // What the bare domain in a bio link is for: served on the domain.
    ["/", "shop"],
    ["/s/studio-one", "shop"],
    ["/S/Studio-One", "shop"],
    // Booking, under every spelling a link uses: booked on the platform.
    ["/book", "book"],
    ["/book/studio-one", "book"],
    ["/BOOK/Studio-One", "book"],
    ["/book/studio-one/group", "book"],
    // Token routes identify ONE booking, not a shop: they stay on the platform.
    ["/book/manage/tok_123", "platform"],
    ["/book/manage/tok_123/wallet-pass", "platform"],
    ["/book/group/tok_456", "platform"],
    // Nothing else is a shop-domain page.
    ["/my-rewards", "platform"],
    ["/r/magic", "platform"],
    ["/login", "platform"],
    ["/dashboard", "platform"],
    ["/privacy", "platform"],
    ["/book/studio-one/somewhere", "platform"],
    ["/s/studio-one/extra", "platform"],
  ];
  it.each(cases)("%s -> %s", (path, target) => {
    expect(customDomainTarget(path)).toBe(target);
  });

  it("🔴 a slug in the path changes nothing: any shop's /s or /book is still THIS domain's", () => {
    // Both targets carry no slug at all - the route they lead to takes the
    // host alone - so a crafted /book/<other-shop> has nothing to reach.
    expect(customDomainTarget("/s/some-other-shop")).toBe(customDomainTarget("/"));
    expect(customDomainTarget("/book/some-other-shop")).toBe(customDomainTarget("/book"));
  });
});
