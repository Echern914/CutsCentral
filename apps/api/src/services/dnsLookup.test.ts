import { afterEach, describe, expect, it } from "vitest";
import {
  OWNERSHIP_TXT_PREFIX,
  VERCEL_APEX_A,
  VERCEL_WWW_CNAME,
  __setDnsResolverForTests,
  lookupDomainDns,
  ownershipRecord,
  provesOwnershipAndPointsHere,
  type DnsResolver,
} from "./dnsLookup.js";

/**
 * The lookup classifier, in isolation. The route tests prove what the
 * classification DOES; this file pins what each answer MEANS - above all that
 * "could not look" and "looked and found nothing" are different words.
 */

const err = (code: string) => Object.assign(new Error(code), { code });

function resolver(over: Partial<DnsResolver>): DnsResolver {
  return {
    resolve4: async () => { throw err("ENOTFOUND"); },
    resolveCname: async () => { throw err("ENOTFOUND"); },
    resolveTxt: async () => { throw err("ENOTFOUND"); },
    ...over,
  };
}

afterEach(() => __setDnsResolverForTests(undefined));

describe("ownershipRecord", () => {
  it("names the _chairback host under the domain and prefixes the token", () => {
    expect(ownershipRecord("example.com", "tok")).toEqual({
      type: "TXT",
      name: "_chairback.example.com",
      value: `${OWNERSHIP_TXT_PREFIX}tok`,
    });
  });
});

describe("apex and www classification", () => {
  it("points_here when Vercel's A is among the answers, whatever else is there", async () => {
    __setDnsResolverForTests(resolver({ resolve4: async () => ["1.2.3.4", VERCEL_APEX_A] }));
    const r = await lookupDomainDns("example.com", null);
    expect(r.apex).toEqual({ status: "points_here", found: VERCEL_APEX_A });
  });

  it("points_elsewhere reports the FIRST address, so the card can name it", async () => {
    __setDnsResolverForTests(resolver({ resolve4: async () => ["203.0.113.9"] }));
    const r = await lookupDomainDns("example.com", null);
    expect(r.apex).toEqual({ status: "points_elsewhere", found: "203.0.113.9" });
  });

  it("missing on ENOTFOUND and on ENODATA - both are the resolver answering 'nothing'", async () => {
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      __setDnsResolverForTests(resolver({ resolve4: async () => { throw err(code); } }));
      expect((await lookupDomainDns("example.com", null)).apex.status).toBe("missing");
    }
  });

  it("🔴 error - not missing - on anything that is not an answer", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EAI_AGAIN"]) {
      __setDnsResolverForTests(resolver({ resolve4: async () => { throw err(code); } }));
      expect((await lookupDomainDns("example.com", null)).apex.status).toBe("error");
    }
  });

  it("www accepts Vercel's CNAME with a trailing dot and any case", async () => {
    __setDnsResolverForTests(
      resolver({ resolveCname: async () => [`${VERCEL_WWW_CNAME.toUpperCase()}.`] }),
    );
    expect((await lookupDomainDns("example.com", null)).www.status).toBe("points_here");
  });
});

describe("TXT ownership classification", () => {
  it("found only for THIS token", async () => {
    __setDnsResolverForTests(
      resolver({ resolveTxt: async () => [[`${OWNERSHIP_TXT_PREFIX}abc`]] }),
    );
    expect((await lookupDomainDns("example.com", "abc")).txt.status).toBe("found");
    expect((await lookupDomainDns("example.com", "xyz")).txt.status).toBe("wrong");
  });

  it("joins a chunked answer before comparing", async () => {
    // Long TXT values arrive split into 255-byte chunks; a naive comparison
    // against chunk[0] would call a correct record 'wrong'.
    const value = `${OWNERSHIP_TXT_PREFIX}abc`;
    __setDnsResolverForTests(
      resolver({ resolveTxt: async () => [[value.slice(0, 10), value.slice(10)]] }),
    );
    expect((await lookupDomainDns("example.com", "abc")).txt.status).toBe("found");
  });

  it("ignores unrelated TXT records on the same host", async () => {
    __setDnsResolverForTests(
      resolver({ resolveTxt: async () => [["v=spf1 -all"], [`${OWNERSHIP_TXT_PREFIX}abc`]] }),
    );
    expect((await lookupDomainDns("example.com", "abc")).txt.status).toBe("found");
  });

  it("missing when no record carries our prefix at all", async () => {
    __setDnsResolverForTests(resolver({ resolveTxt: async () => [["v=spf1 -all"]] }));
    expect((await lookupDomainDns("example.com", "abc")).txt.status).toBe("missing");
  });

  it("never returns the value it found", async () => {
    __setDnsResolverForTests(
      resolver({ resolveTxt: async () => [[`${OWNERSHIP_TXT_PREFIX}somebody-elses`]] }),
    );
    const r = await lookupDomainDns("example.com", "abc");
    expect(JSON.stringify(r)).not.toContain("somebody-elses");
  });
});

describe("provesOwnershipAndPointsHere", () => {
  const base = { www: { status: "missing" as const, found: null }, checkedAt: "" };
  it("needs the TXT proof AND the apex", () => {
    expect(provesOwnershipAndPointsHere({
      ...base, apex: { status: "points_here", found: VERCEL_APEX_A }, txt: { status: "found" },
    })).toBe(true);
    expect(provesOwnershipAndPointsHere({
      ...base, apex: { status: "points_here", found: VERCEL_APEX_A }, txt: { status: "missing" },
    })).toBe(false);
    expect(provesOwnershipAndPointsHere({
      ...base, apex: { status: "points_elsewhere", found: "1.1.1.1" }, txt: { status: "found" },
    })).toBe(false);
    // An error is not proof of anything, in either direction.
    expect(provesOwnershipAndPointsHere({
      ...base, apex: { status: "error", found: null }, txt: { status: "found" },
    })).toBe(false);
  });
});
