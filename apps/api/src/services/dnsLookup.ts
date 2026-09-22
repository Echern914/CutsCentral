import { promises as dns } from "node:dns";

/**
 * What a shop's custom domain currently resolves to, from OUR side.
 *
 * Two jobs, and they are different in kind:
 *
 *   OWNERSHIP. The `_chairback.<domain>` TXT record carries a secret minted for
 *   one shop. Only somebody who can write that zone can publish it, so finding
 *   it is proof the shop making the claim controls the domain. This is the
 *   security property; nothing about it comes from Vercel.
 *
 *   DIAGNOSIS. What the apex and www records actually point at, so the
 *   dashboard can say "your A record currently points to 203.0.113.9" instead
 *   of "waiting on DNS" - which is what turned three of three connections in
 *   production into abandoned setups.
 *
 * Never throws. A resolver that is down, slow or answering garbage is reported
 * as `error`, and an `error` never counts as proof of anything.
 */

/** Vercel's stable anycast address for an apex A record. */
export const VERCEL_APEX_A = "76.76.21.21";
/** Vercel's stable CNAME target for www. */
export const VERCEL_WWW_CNAME = "cname.vercel-dns.com";
/** The host the ownership record lives on, under the shop's domain. */
export const OWNERSHIP_TXT_HOST = "_chairback";
/** The record's value prefix; the shop's token follows the `=`. */
export const OWNERSHIP_TXT_PREFIX = "chairback-verify=";

/** A lookup that has not answered by now is treated as an error, not as absence. */
const LOOKUP_TIMEOUT_MS = 4_000;

export type RecordStatus = "points_here" | "points_elsewhere" | "missing" | "error";
export type TxtStatus = "found" | "wrong" | "missing" | "error";

export interface DomainDnsReport {
  /** The bare domain's A record. `found` is what it points at, when it points anywhere. */
  apex: { status: RecordStatus; found: string | null };
  /** The www CNAME. */
  www: { status: RecordStatus; found: string | null };
  /** The ownership TXT record. Never exposes the value it found. */
  txt: { status: TxtStatus };
  checkedAt: string;
}

/** The three calls this needs, so a test can stand in for the network. */
export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  resolveTxt(host: string): Promise<string[][]>;
}

const realResolver: DnsResolver = {
  resolve4: (h) => dns.resolve4(h),
  resolveCname: (h) => dns.resolveCname(h),
  resolveTxt: (h) => dns.resolveTxt(h),
};

let testResolver: DnsResolver | undefined;

/** Test seam, mirroring the messaging providers' `__set*ForTests`. */
export function __setDnsResolverForTests(r: DnsResolver | undefined): void {
  testResolver = r;
}

function resolver(): DnsResolver {
  return testResolver ?? realResolver;
}

/** The TXT record a shop must publish for `token`. */
export function ownershipRecord(domain: string, token: string): {
  type: "TXT";
  name: string;
  value: string;
} {
  return {
    type: "TXT",
    name: `${OWNERSHIP_TXT_HOST}.${domain}`,
    value: `${OWNERSHIP_TXT_PREFIX}${token}`,
  };
}

/**
 * Run one lookup with a deadline. "No such record" is a normal answer
 * (`missing`); a timeout or a resolver failure is not, and must never be read
 * as absence - that is the difference between "your record is not there" and
 * "we could not look just now".
 */
async function attempt<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; kind: "missing" | "error" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ENOTFOUND / ENODATA: the resolver answered, and the answer is "nothing
    // there". Everything else - timeout, SERVFAIL, refused, network - is unknown.
    if (code === "ENOTFOUND" || code === "ENODATA") return { ok: false, kind: "missing" };
    return { ok: false, kind: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function lookupDomainDns(
  domain: string,
  expectedToken: string | null,
): Promise<DomainDnsReport> {
  const r = resolver();
  const [apex, www, txt] = await Promise.all([
    attempt(() => r.resolve4(domain)),
    attempt(() => r.resolveCname(`www.${domain}`)),
    attempt(() => r.resolveTxt(`${OWNERSHIP_TXT_HOST}.${domain}`)),
  ]);

  const apexReport: DomainDnsReport["apex"] = !apex.ok
    ? { status: apex.kind, found: null }
    : apex.value.includes(VERCEL_APEX_A)
      ? { status: "points_here", found: VERCEL_APEX_A }
      : { status: apex.value.length ? "points_elsewhere" : "missing", found: apex.value[0] ?? null };

  const wwwReport: DomainDnsReport["www"] = !www.ok
    ? { status: www.kind, found: null }
    : www.value.some((c) => c.toLowerCase().replace(/\.$/, "") === VERCEL_WWW_CNAME)
      ? { status: "points_here", found: VERCEL_WWW_CNAME }
      : { status: www.value.length ? "points_elsewhere" : "missing", found: www.value[0] ?? null };

  let txtStatus: TxtStatus;
  if (!txt.ok) {
    txtStatus = txt.kind;
  } else {
    // A TXT answer is an array of chunk arrays; a long value arrives split.
    const values = txt.value.map((chunks) => chunks.join(""));
    const ours = values.filter((v) => v.startsWith(OWNERSHIP_TXT_PREFIX));
    if (ours.length === 0) txtStatus = "missing";
    else if (expectedToken && ours.includes(`${OWNERSHIP_TXT_PREFIX}${expectedToken}`)) {
      txtStatus = "found";
    } else {
      // A record with our prefix but somebody else's token: a previous
      // connection, or another shop's claim. Not proof for THIS shop.
      txtStatus = "wrong";
    }
  }

  return {
    apex: apexReport,
    www: wwwReport,
    txt: { status: txtStatus },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The one question the redirect gate asks. Ownership is the TXT record and
 * nothing else; the apex check is there so "Connected" is not shown for a
 * domain that proves ownership but still sends visitors somewhere else.
 */
export function provesOwnershipAndPointsHere(report: DomainDnsReport): boolean {
  return report.txt.status === "found" && report.apex.status === "points_here";
}
