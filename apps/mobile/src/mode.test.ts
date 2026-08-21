import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DESTINATION, isMode, resolveReturn, returnToDashboard } from "./mode";

/**
 * The role picker's way OUT.
 *
 * "⇄ Switch" sits one tap away in the top strip of every dashboard, so people
 * land on the role picker by accident constantly - and until now the only way
 * off it was to pick a role again, because the Switch itself deleted the saved
 * mode on the way there. These tests pin the three ways someone arrives and the
 * one rule that holds in all of them: leaving is pure navigation, never a
 * sign-out and never a change of role.
 */

const MODES = ["barber", "manager", "customer"] as const;

describe("normal navigation - Switch, then straight back", () => {
  it.each([
    ["barber", "/login"],
    ["manager", "/login"],
    ["customer", "/customer"],
  ] as const)("sends a saved %s back to %s", (mode, dest) => {
    const navigate = vi.fn();
    expect(returnToDashboard(mode, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(dest);
  });

  it("returns barber and manager to /login, NOT straight to the dashboard WebView", () => {
    // /login is the self-healing door: a barber holding a session is redirected
    // through it to /barber without ever seeing it, and one whose session
    // expired gets the native sign-in instead of a WebView that can only 401.
    // Going "back" must not be the one path that skips it.
    expect(resolveReturn("barber")).toBe("/login");
    expect(resolveReturn("manager")).toBe("/login");
  });

  it("can never disagree with the row the picker would have offered", () => {
    // The arrow and the three rows resolve through the SAME table. If someone
    // adds a fourth mode, this fails until both sides know about it.
    for (const mode of MODES) expect(resolveReturn(mode)).toBe(DESTINATION[mode]);
  });
});

describe("direct page access - no screen came before this one", () => {
  it("still returns a returning user to their default dashboard", () => {
    // Cold launch, deep link, or an OS process restore straight onto the
    // picker: nothing preceded it, but a saved mode still names the right
    // dashboard, so the arrow works exactly as it does mid-session.
    const navigate = vi.fn();
    expect(returnToDashboard("customer", navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/customer");
  });

  it("offers NO back target on a genuine first run", () => {
    // No mode has ever been chosen, so there is no previous page and no default
    // dashboard either. resolveReturn returning null is what stops the picker
    // rendering an arrow that would have nowhere to go.
    const navigate = vi.fn();
    expect(resolveReturn(null)).toBeNull();
    expect(returnToDashboard(null, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("treats an unreadable or legacy stored value as no mode at all", () => {
    // AsyncStorage failing (undefined) or holding something from an older build
    // must degrade to "show the picker, no arrow" - never a crash, and never a
    // navigation somewhere invented.
    for (const junk of [undefined, "", "owner", "BARBER", "null"]) {
      const navigate = vi.fn();
      expect(isMode(junk)).toBe(false);
      expect(resolveReturn(junk)).toBeNull();
      expect(returnToDashboard(junk, navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    }
  });
});

describe("system back - the gesture behaves like the arrow", () => {
  it("goes to the same place the arrow does", () => {
    // Both call returnToDashboard, so this is parity by construction; the test
    // exists so a future "quick fix" that special-cases one of them fails here.
    const fromArrow = vi.fn();
    const fromGesture = vi.fn();
    returnToDashboard("barber", fromArrow);
    returnToDashboard("barber", fromGesture);
    expect(fromGesture.mock.calls).toEqual(fromArrow.mock.calls);
  });

  it("reports the event CONSUMED so Android doesn't quit the app", () => {
    // The return value goes straight to the hardwareBackPress listener. true =
    // "handled, stay put": pressing back on the picker must land on the
    // dashboard, not drop the user out of the app entirely.
    expect(returnToDashboard("barber", vi.fn())).toBe(true);
  });

  it("declines the event on a first run, so the OS default stands", () => {
    // Nothing behind us: quitting from the app's genuine first screen is the
    // correct system behaviour, so we must NOT swallow the press.
    expect(returnToDashboard(null, vi.fn())).toBe(false);
  });
});

describe("leaving changes nothing about the account", () => {
  it("navigates and does nothing else", () => {
    const navigate = vi.fn();
    returnToDashboard("barber", navigate);
    // One call, one argument: a route. No token, no user, nothing to revoke.
    expect(navigate.mock.calls).toEqual([["/login"]]);
  });

  it("cannot sign anyone out or reset their role, because it holds no such power", () => {
    // The guarantee is structural, and this asserts the structure - because the
    // next person to touch that file is the risk. A stray
    // removeItem(STORAGE.mode) added back "for cleanliness" would silently
    // restore the exact dead end this change removes.
    //
    // mode.ts imports NOTHING: not AsyncStorage, not the auth helpers, not even
    // expo-router. A module with no imports cannot reach storage or a session
    // however hard it tries, which makes this a complete proof rather than a
    // list of forbidden names somebody has to remember to keep topped up.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "mode.ts"), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(importLines).toEqual([]);
  });
});
