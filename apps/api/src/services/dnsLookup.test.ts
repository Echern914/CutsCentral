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
  it("goes on @ - the same Name as the A record - and prefixes the token", () => {
    expect(ownershipRecord("tok")).toEqual({
      type: "TXT",
      name: "@",
      value: `${OWNERSHIP_TXT_PREFIX}tok`,
    });
  });
});

/**
 * 🔴 THE TWO LOCATIONS. The record is SHOWN on `@` and ACCEPTED on `@` or the
 * older `_chairback.<domain>`. These answer per HOST, unlike the classifier
 * tests below, because "which host was it on" is the whole question.
 */
describe("TXT ownership - where the record may live", () => {
  const ROOT = "example.com";
  const LEGACY = "_chairback.example.com";
  const tok = [`${OWNERSHIP_TXT_PREFIX}abc`];

  /** A resolver whose TXT answer depends on the host asked. */
  function txtBy(byHost: Record<string, string[][] | Error>): DnsResolver {
    return resolver({
      resolveTxt: async (host) => {
        const a = byHost[host];
        if (a === undefined) throw err("ENOTFOUND");
        if (a instanceof Error) throw a;
        return a;
      },
    });
  }

  it("found on the ROOT alone - what an owner types when the A record is on @", async () => {
    __setDnsResolverForTests(txtBy({ [ROOT]: [["v=spf1 include:_spf.google.com ~all"], tok] }));
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("found");
  });

  it("🔴 still found on the OLD _chairback host alone - a record our own instructions asked for keeps counting", async () => {
    __setDnsResolverForTests(txtBy({ [ROOT]: [["v=spf1 -all"]], [LEGACY]: [tok] }));
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("found");
  });

  it("asks exactly those two hosts, and no others", async () => {
    const asked: string[] = [];
    __setDnsResolverForTests(
      resolver({
        resolveTxt: async (host) => {
          asked.push(host);
          throw err("ENOTFOUND");
        },
      }),
    );
    await lookupDomainDns(ROOT, "abc");
    expect(asked.sort()).toEqual([LEGACY, ROOT].sort());
  });

  it("found in one place beats somebody else's token in the other", async () => {
    __setDnsResolverForTests(
      txtBy({ [ROOT]: [[`${OWNERSHIP_TXT_PREFIX}old-connection`]], [LEGACY]: [tok] }),
    );
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("found");
  });

  it("wrong when a stale token is on the root and nothing is on the old host", async () => {
    __setDnsResolverForTests(txtBy({ [ROOT]: [[`${OWNERSHIP_TXT_PREFIX}old-connection`]] }));
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("wrong");
  });

  it("🔴 error - NOT missing - when one host could not be read and the other is empty", async () => {
    // The token may be sitting exactly where we could not look.
    __setDnsResolverForTests(txtBy({ [ROOT]: err("ETIMEOUT") }));
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("error");
  });

  it("🔴 error - NOT wrong - when one host could not be read and the other holds a stale token", async () => {
    // "Replace it" would be bad advice if the right record is on the host we
    // could not read.
    __setDnsResolverForTests(
      txtBy({ [ROOT]: err("ESERVFAIL"), [LEGACY]: [[`${OWNERSHIP_TXT_PREFIX}old-connection`]] }),
    );
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("error");
  });

  it("an unreadable host does not hide proof found on the other", async () => {
    __setDnsResolverForTests(txtBy({ [ROOT]: err("ETIMEOUT"), [LEGACY]: [tok] }));
    expect((await lookupDomainDns(ROOT, "abc")).txt.status).toBe("found");
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
