import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// My ChairBack wears the web's Studio look (2026-11-16 redesign). 1.1.8 shipped
// the web redesign but not the app's own tabs, which still had a gold "View
// details" button on cream (Eric, 2026-11-17). These tests hold the app's
// tokens to the web's, so the two cannot drift apart again.
//
// Read as text: theme.ts and ui.tsx import react-native, which this node-only
// runner cannot load.
const here = dirname(fileURLToPath(import.meta.url));
const theme = readFileSync(join(here, "theme.ts"), "utf8");
const ui = readFileSync(join(here, "ui.tsx"), "utf8");
const css = readFileSync(join(here, "..", "..", "..", "web", "src", "app", "globals.css"), "utf8");

function token(name: string): string | undefined {
  return new RegExp(`\\b${name}: "(#[0-9A-Fa-f]{6})"`).exec(theme)?.[1]?.toUpperCase();
}

/** A light-mode `--cb-x: r g b;` from the web's :root block, as #RRGGBB. */
function webLight(name: string): string {
  const root = css.slice(css.indexOf(":root {"));
  const m = new RegExp(`--cb-${name}:\\s*(\\d+) (\\d+) (\\d+);`).exec(root);
  if (!m) throw new Error(`--cb-${name} not found`);
  return (
    "#" +
    m
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

describe("the app's colours are the web's Studio colours", () => {
  it.each([
    ["bg", "bg"],
    ["surface", "s800"],
    ["surfaceRaised", "s700"],
    ["text", "fg"],
    ["textSecondary", "fg-muted"],
    ["primary", "primary"],
    ["onPrimary", "on-primary"],
    ["gold", "gold-fill"],
    ["goldText", "gold"],
  ])("%s = web --cb-%s", (app, web) => {
    expect(token(app)).toBe(webLight(web));
  });
});

describe("🔴 the primary button is ink, gold is an accent", () => {
  it("the primary button fills with `primary` and labels with `onPrimary`", () => {
    expect(ui).toMatch(/btnPrimary: \{ backgroundColor: color\.primary \}/);
    expect(ui).toMatch(/variant === "primary" \? "onPrimary"/);
  });

  it("the old gold button would fail", () => {
    expect(ui).not.toMatch(/btnPrimary: \{ backgroundColor: color\.gold \}/);
    expect(token("primary")).not.toBe(token("gold"));
  });

  it("the wordmark is ink, not gold", () => {
    const mark = ui.slice(ui.indexOf("export function Wordmark"), ui.indexOf("export function Tap"));
    expect(mark).toMatch(/color: color\.text/);
    expect(mark).not.toMatch(/goldText/);
  });
});
