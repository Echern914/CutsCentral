import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_INSET_SCRIPT, HOME_INDICATOR_PX, applyAppBottomInset, type AppInsetWindow } from "./appSafeArea";

/**
 * The home-indicator gap inside the iOS app. On 2026-11-16 the dashboard's tab
 * labels sat under the indicator on a Face ID iPhone, because every bottom bar
 * read env(safe-area-inset-bottom) and the app's WebView reports 0 for it.
 */

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

function fakeWindow(opts: { inApp: boolean; ua: string; w: number; h: number }) {
  const set: Record<string, string> = {};
  const win: AppInsetWindow = {
    ...(opts.inApp ? { ReactNativeWebView: { postMessage() {} } } : {}),
    navigator: { userAgent: opts.ua },
    screen: { width: opts.w, height: opts.h },
    document: {
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            set[name] = value;
          },
        },
      },
    },
  };
  return { win, set };
}

describe("applyAppBottomInset", () => {
  // screen.width x screen.height in CSS px, as the phone reports it.
  const faceIdPhones: [string, number, number][] = [
    ["iPhone 16 / 15 / 14", 390, 844],
    ["iPhone 16 Pro", 402, 874],
    ["iPhone 16 Pro Max", 440, 956],
    ["iPhone 15 Plus", 430, 932],
    ["iPhone 13 mini", 375, 812],
    ["iPhone 12 mini with Display Zoom", 320, 693],
  ];

  it.each(faceIdPhones)("leaves the indicator's 34px on a %s in the app", (_name, w, h) => {
    const { win, set } = fakeWindow({ inApp: true, ua: IPHONE_UA, w, h });
    expect(applyAppBottomInset(win)).toBe(HOME_INDICATOR_PX);
    expect(set["--cb-app-inset-bottom"]).toBe("34px");
  });

  it("leaves no gap on a home-button iPhone (SE, 8), which has no indicator", () => {
    const homeButtonPhones: [number, number][] = [
      [375, 667],
      [320, 568],
      [414, 736],
    ];
    for (const [w, h] of homeButtonPhones) {
      const { win, set } = fakeWindow({ inApp: true, ua: IPHONE_UA, w, h });
      expect(applyAppBottomInset(win)).toBe(0);
      expect(set["--cb-app-inset-bottom"]).toBe("0px");
    }
  });

  it("leaves it to env() in Safari, where the browser reports the inset itself", () => {
    const { win } = fakeWindow({ inApp: false, ua: IPHONE_UA, w: 390, h: 844 });
    expect(applyAppBottomInset(win)).toBe(0);
  });

  it("adds nothing on Android or a desktop browser", () => {
    expect(applyAppBottomInset(fakeWindow({ inApp: true, ua: ANDROID_UA, w: 412, h: 915 }).win)).toBe(0);
    expect(applyAppBottomInset(fakeWindow({ inApp: false, ua: "Mozilla/5.0 (Windows NT 10.0)", w: 1920, h: 1080 }).win)).toBe(0);
  });

  it("does not divide by zero on a screen that reports no size", () => {
    expect(applyAppBottomInset(fakeWindow({ inApp: true, ua: IPHONE_UA, w: 0, h: 0 }).win)).toBe(0);
  });
});

describe("APP_INSET_SCRIPT", () => {
  // The script is the function's SOURCE inlined into the page, so it only works
  // if the function reaches nothing outside its own body. Running the string on
  // its own proves that: a stray outer reference would throw, the script's
  // try/catch would swallow it, and the property would never be set.
  it("runs on its own as an inline script and sets the gap", () => {
    const { win, set } = fakeWindow({ inApp: true, ua: IPHONE_UA, w: 390, h: 844 });
    new Function("window", APP_INSET_SCRIPT)(win);
    expect(set["--cb-app-inset-bottom"]).toBe("34px");
  });

  it("never throws into the page, even with no screen at all", () => {
    expect(() => new Function("window", APP_INSET_SCRIPT)({})).not.toThrow();
  });
});

describe("bottom surfaces clear the gap through --cb-safe-bottom", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("globals.css folds the app's gap into --cb-safe-bottom", () => {
    const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
    expect(css).toMatch(
      /--cb-safe-bottom:\s*max\(env\(safe-area-inset-bottom, 0px\), var\(--cb-app-inset-bottom, 0px\)\)/,
    );
  });

  // A bare env() reads 0 in the app, which is the bug itself. The dashboard and
  // the shared sheet/toast primitives it uses must go through the variable.
  it("no dashboard surface reads env(safe-area-inset-bottom) directly", () => {
    const roots = [join(SRC, "app", "dashboard"), join(SRC, "components", "ui")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(path, "utf8").includes("env(safe-area-inset-bottom")) {
            offenders.push(relative(SRC, path));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
