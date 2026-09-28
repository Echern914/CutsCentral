import { describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { emailAddressKey, suppressionAddressHash, suppressionAddressKey } from "./broadcastAudience.js";

/**
 * 🔴 THE MIGRATION AND THE APP MUST HASH AN ADDRESS THE SAME WAY.
 *
 * EmailAddressSuppression was backfilled in SQL (email_address_hash, migration
 * 20261026000000) and is written and read by the app (suppressionAddressHash).
 * If the two disagreed on even one spelling, a backfilled unsubscribe would
 * never match the address it was about, and that address would quietly become
 * mailable. So this runs the live SQL function against the TypeScript one.
 *
 * Non-ASCII characters are built from code points (`u(...)`) so that none of
 * them is invisible in this file.
 */

const SHOP = "cm0shopsupptest0000000001";
const u = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const NBSP = u(0xa0);
const IDEOGRAPHIC_SPACE = u(0x3000);
const BOM = u(0xfeff);

async function sqlHashes(inputs: (string | null)[]): Promise<(string | null)[]> {
  const rows = await prisma.$queryRaw<{ i: bigint; h: string | null }[]>`
    SELECT t.i, email_address_hash(${SHOP}, t.e) AS h
      FROM unnest(${inputs}::text[]) WITH ORDINALITY AS t(e, i)
     ORDER BY t.i`;
  return rows.map((r) => r.h);
}

const tsHashes = (inputs: (string | null)[]) => inputs.map((e) => suppressionAddressHash(SHOP, e));

/** Every code point, one at a time, as a string. */
function everyCodePoint(): string[] {
  const out: string[] = [];
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    out.push(String.fromCodePoint(cp));
  }
  return out;
}

describe("🔴 email_address_hash (SQL) and suppressionAddressHash (TypeScript) agree", () => {
  it("on mixed case and padding", async () => {
    const inputs = [
      "pat@example.com",
      "Pat@Example.COM",
      "  pat@example.com  ",
      "\tPAT@EXAMPLE.COM\n",
      `${NBSP}${IDEOGRAPHIC_SPACE}pat@example.com${BOM}`,
      "\r\n Pat.Sample+cuts@Example.co.uk \r\n",
      "first last@example.com", // an inner space is kept by both
      "O'Brien@Example.com",
    ];
    const sql = await sqlHashes(inputs);
    expect(sql).toEqual(tsHashes(inputs));
    // And the spellings of one address really are one hash.
    expect(new Set(sql.slice(0, 5)).size).toBe(1);
  });

  it("on non-ASCII addresses - the letters Postgres's lower() and toLowerCase() disagree on", async () => {
    const inputs = [
      `${u(0xc9)}mile@example.com`, // capital E acute
      `${u(0xe9)}mile@example.com`, // small e acute
      `${u(0x130)}nci@example.com`, // dotted capital I: TWO characters in toLowerCase()
      `${u(0x391, 0x3a3)}@example.com`, // Greek capitals ending in sigma: context-dependent
      `${u(0x1c5)}ivko@example.com`, // a title-case letter
      `STRA${u(0x1e9e)}E@example.com`, // capital sharp s
      `stra${u(0xdf)}e@example.com`, // small sharp s
      `pat${u(0x200b)}@example.com`, // a zero-width space, which trim() keeps
      `e${u(0x301)}mile@example.com`, // e acute, decomposed
      `${u(0x1f488)}@example.com`, // an astral character
      `${NBSP}${u(0xc9)}mile@Example.com${IDEOGRAPHIC_SPACE}`,
    ];
    expect(await sqlHashes(inputs)).toEqual(tsHashes(inputs));
  });

  it("on every ASCII character, anywhere in the address", async () => {
    const inputs: string[] = [];
    for (let cp = 1; cp <= 127; cp++) {
      const c = String.fromCharCode(cp);
      inputs.push(`${c}ab@X.co`, `aB${c}@x.co`, `ab@x.Co${c}`);
    }
    expect(await sqlHashes(inputs)).toEqual(tsHashes(inputs));
  });

  it("on every character JavaScript's trim() removes, at either end", async () => {
    const trimmed = everyCodePoint().filter((c) => `x${c}`.trim() === "x" && `${c}x`.trim() === "x");
    expect(trimmed).toHaveLength(25);
    const inputs = trimmed.map((c) => `${c}${c}Pat@Example.com${c}`);
    expect(await sqlHashes(inputs)).toEqual(tsHashes(inputs));
  });

  it("on no address at all: both say null", async () => {
    const inputs = [null, "", "   ", "\t\n", `${NBSP}${IDEOGRAPHIC_SPACE}${BOM}`];
    expect(tsHashes(inputs)).toEqual(inputs.map(() => null));
    expect(await sqlHashes(inputs)).toEqual(inputs.map(() => null));
  });
});

describe("suppressionAddressKey", () => {
  it("trims exactly what trim() trims, for every code point", () => {
    // Each character wrapped around a letter: the key must strip it exactly
    // when trim() does, and keep it exactly when trim() does.
    const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const mismatches = everyCodePoint().filter((c) => {
      const s = `${c}a${c}`;
      return suppressionAddressKey(s) !== fold(s.trim());
    });
    expect(mismatches.map((c) => c.codePointAt(0))).toEqual([]);
  });

  it("is emailAddressKey for an ASCII address - which is nearly every address", () => {
    for (const e of ["Pat@Example.COM", " \tsam.sample+x@example.co.uk\r\n", "O'BRIEN@EXAMPLE.COM"]) {
      expect(suppressionAddressKey(e)).toBe(emailAddressKey(e));
    }
  });

  it("folds A-Z only: a non-ASCII capital is kept, rather than guessed at", () => {
    expect(suppressionAddressKey(` ${u(0xc9)}MILE@Example.com `)).toBe(`${u(0xc9)}mile@example.com`);
  });

  it("hashes as sha256 hex of `shopId:key`, scoped to the shop", () => {
    expect(suppressionAddressHash(SHOP, "pat@example.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(suppressionAddressHash(SHOP, "pat@example.com")).not.toBe(
      suppressionAddressHash("another-shop", "pat@example.com"),
    );
  });
});
