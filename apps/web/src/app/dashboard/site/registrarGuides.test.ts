import { describe, expect, it } from "vitest";
import {
  EVERYWHERE,
  REGISTRAR_GUIDES,
  guideById,
  hostFor,
  relativeRecordName,
} from "./registrarGuides";

/**
 * The name rules are the part of the guide that can be WRONG in a way the
 * owner cannot see: a fully-qualified name typed into a registrar that
 * appends the domain itself is stored doubled and never resolves.
 */

describe("relativeRecordName - what the owner should type", () => {
  it("the domain itself is @, however it arrives", () => {
    expect(relativeRecordName("@", "example.com")).toBe("@");
    expect(relativeRecordName("example.com", "example.com")).toBe("@");
    expect(relativeRecordName("Example.COM.", "example.com")).toBe("@");
  });

  it("a name under the domain loses the domain", () => {
    expect(relativeRecordName("www", "example.com")).toBe("www");
    expect(relativeRecordName("_vercel.example.com", "example.com")).toBe("_vercel");
    expect(relativeRecordName("_vercel.example.com.", "example.com")).toBe("_vercel");
  });

  it("🔴 only strips on a LABEL boundary - notexample.com is not under example.com", () => {
    expect(relativeRecordName("notexample.com", "example.com")).toBe("notexample.com");
  });

  it("a name under a DIFFERENT domain is left alone - shortening it would point elsewhere", () => {
    expect(relativeRecordName("_vercel.other.com", "example.com")).toBe("_vercel.other.com");
  });

  it("with no domain yet, names pass through", () => {
    expect(relativeRecordName("www", null)).toBe("www");
    expect(relativeRecordName("@", null)).toBe("@");
  });
});

describe("hostFor - the company's own rule for the root", () => {
  it("@ where the company writes @, empty where it wants the field blank", () => {
    expect(hostFor(guideById("godaddy"), "@", "example.com")).toBe("@");
    expect(hostFor(guideById("porkbun"), "@", "example.com")).toBe("");
    expect(hostFor(guideById("wix"), "example.com", "example.com")).toBe("");
  });

  it("everything else is the relative name at every company", () => {
    for (const g of REGISTRAR_GUIDES) {
      expect(hostFor(g, "www", "example.com")).toBe("www");
      expect(hostFor(g, "_vercel.example.com", "example.com")).toBe("_vercel");
    }
  });
});

describe("the guides themselves", () => {
  it("every company has steps and at least one watch-out, ids are unique, and 'somewhere else' comes last", () => {
    const ids = REGISTRAR_GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe("other");
    for (const g of REGISTRAR_GUIDES) {
      expect(g.steps.length, g.id).toBeGreaterThan(0);
      expect(g.watchOut.length, g.id).toBeGreaterThan(0);
    }
  });

  it("a company that wants the root BLANK says so in words - an empty cell alone reads as a mistake", () => {
    for (const g of REGISTRAR_GUIDES.filter((x) => x.root === "")) {
      const copy = [...g.steps, ...g.watchOut].join(" ");
      expect(copy, g.id).toMatch(/\b(empty|blank)\b/i);
    }
  });

  it("🔴 Cloudflare's A and CNAME must say DNS only - the orange cloud hides where the domain points", () => {
    expect(guideById("cloudflare").pointerRowNote).toMatch(/DNS only/);
  });

  it("🔴 no guide still sends anyone to the old _chairback host", () => {
    const all = REGISTRAR_GUIDES.flatMap((g) => [...g.steps, ...g.watchOut]).concat(EVERYWHERE);
    for (const line of all) expect(line).not.toMatch(/_chairback/);
  });

  it("every guide protects email: MX and SPF records are named as the ones to leave alone", () => {
    expect(EVERYWHERE.join(" ")).toMatch(/MX/);
    expect(EVERYWHERE.join(" ")).toMatch(/v=spf1/);
  });
});
