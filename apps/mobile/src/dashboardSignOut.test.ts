import { describe, expect, it, vi } from "vitest";
import { isSignedOutMessage, isSignedOutUrl, once, URL_WATCH_SCRIPT } from "./dashboardSignOut";

const WEB = "https://www.example.test";
const barber = { webOrigin: WEB, isDemo: false };
const demo = { webOrigin: WEB, isDemo: true };

/**
 * A stand-in for the WebView's page: a history whose pushState/replaceState
 * move location.href, popstate listeners, and the react-native-webview bridge.
 */
function page(start: string) {
  const posted: string[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const win = {
    location: { href: start },
    history: {
      pushState(_s: unknown, _t: string, url: string) {
        win.location.href = new URL(url, win.location.href).href;
      },
      replaceState(_s: unknown, _t: string, url: string) {
        win.location.href = new URL(url, win.location.href).href;
      },
    } as Record<string, (...a: never[]) => unknown>,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    ReactNativeWebView: { postMessage: (m: string) => posted.push(m) },
  };
  // Runs exactly as the WebView would run it: a script with `window` in scope.
  new Function("window", URL_WATCH_SCRIPT)(win);
  return {
    win,
    posted,
    back(to: string) {
      win.location.href = new URL(to, win.location.href).href;
      for (const fn of listeners.popstate ?? []) fn();
    },
  };
}

describe("the dashboard's in-page sign-out reaches the app", () => {
  it("🔴 Sign out's redirect('/login') is an in-page pushState - the injected watcher reports it", () => {
    const p = page(`${WEB}/dashboard`);
    // What Next does with a server action's redirect: no navigation, just history.
    p.win.history.pushState!({} as never, "" as never, "/login" as never);
    expect(p.posted).toHaveLength(1);
    expect(p.posted.some((m) => isSignedOutMessage(m, barber))).toBe(true);
  });

  it("🔴 Exit demo's redirect('/') is caught in the demo", () => {
    const p = page(`${WEB}/demo/dashboard`);
    p.win.history.replaceState!({} as never, "" as never, "/" as never);
    expect(p.posted.some((m) => isSignedOutMessage(m, demo))).toBe(true);
  });

  it("back/forward is reported too, and an unchanged address only once", () => {
    const p = page(`${WEB}/dashboard`);
    p.win.history.replaceState!({} as never, "" as never, "/dashboard/clients" as never);
    p.win.history.replaceState!({} as never, "" as never, "/dashboard/clients" as never);
    p.back("/login");
    expect(p.posted.map((m) => JSON.parse(m).url)).toEqual([`${WEB}/dashboard/clients`, `${WEB}/login`]);
  });

  it("still does what the page asked: history moves", () => {
    const p = page(`${WEB}/dashboard`);
    p.win.history.pushState!({} as never, "" as never, "/dashboard/calendar" as never);
    expect(p.win.location.href).toBe(`${WEB}/dashboard/calendar`);
  });

  it("injected twice (a reload of the same document), it still reports once", () => {
    const p = page(`${WEB}/dashboard`);
    new Function("window", URL_WATCH_SCRIPT)(p.win);
    p.win.history.pushState!({} as never, "" as never, "/login" as never);
    expect(p.posted).toHaveLength(1);
  });
});

describe("which addresses are the signed-out side", () => {
  it("/login, with or without a next=, a slash or a hash", () => {
    for (const url of [`${WEB}/login`, `${WEB}/login?next=%2Fdashboard`, `${WEB}/login/`, `${WEB}/login#x`]) {
      expect(isSignedOutUrl(url, barber)).toBe(true);
    }
  });

  it("the dashboard and its pages are not", () => {
    for (const url of [`${WEB}/dashboard`, `${WEB}/dashboard/account`, `${WEB}/login-help`, `${WEB}/signup`]) {
      expect(isSignedOutUrl(url, barber)).toBe(false);
    }
  });

  it("'/' is leaving only in the demo", () => {
    expect(isSignedOutUrl(`${WEB}/`, demo)).toBe(true);
    expect(isSignedOutUrl(WEB, demo)).toBe(true);
    expect(isSignedOutUrl(`${WEB}/`, barber)).toBe(false);
  });

  it("another origin, or a lookalike host, is never ours", () => {
    expect(isSignedOutUrl("https://elsewhere.example/login", barber)).toBe(false);
    expect(isSignedOutUrl(`${WEB}.evil.example/login`, barber)).toBe(false);
  });

  it("only a cb:url message with a string url counts", () => {
    expect(isSignedOutMessage(JSON.stringify({ type: "cb:url", url: `${WEB}/login` }), barber)).toBe(true);
    expect(isSignedOutMessage(JSON.stringify({ type: "cb:auth", url: `${WEB}/login` }), barber)).toBe(false);
    expect(isSignedOutMessage(JSON.stringify({ type: "cb:url", url: 7 }), barber)).toBe(false);
    expect(isSignedOutMessage("cb:ready", barber)).toBe(false);
  });

  it("three signals for one sign-out run it once", () => {
    const leave = vi.fn();
    const go = once(leave);
    go();
    go();
    go();
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
