import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";

/**
 * Where a tapped link lands. A shop's /r/<token> link has no route of its own
 * in the app; left alone it would hit the router's "unmatched route" screen.
 * It must open that shop's page inside My ChairBack instead - and nothing
 * else the app is linked to may be disturbed.
 */
const go = (path: string) => redirectSystemPath({ path, initial: true });

describe("a shop's link opens that shop inside My ChairBack", () => {
  it.each([
    "https://getchairback.com/r/Abc_123-xyz",
    "chairback://r/Abc_123-xyz",
    "/r/Abc_123-xyz",
    "https://getchairback.com/r/Abc_123-xyz/rewards",
    "https://getchairback.com/r/Abc_123-xyz?utm=text",
  ])("%s", (path) => {
    expect(go(path)).toBe("/customer/link?token=Abc_123-xyz");
  });

  it("an encoded token is decoded once, then safely re-encoded", () => {
    expect(go("/r/a%2Bb")).toBe("/customer/link?token=a%2Bb");
  });
});

describe("every other link passes through untouched", () => {
  it.each(["/team/join?code=abc", "/auth/mobile/callback?state=x", "/", "/customer"])("%s", (path) => {
    expect(go(path)).toBe(path);
  });

  it("a malformed link goes to the start, never a crash", () => {
    expect(go("/r/%E0%A4%A")).toBe("/");
  });
});
