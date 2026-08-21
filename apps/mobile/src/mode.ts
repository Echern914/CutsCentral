/**
 * What a "mode" is, and where each one leads.
 *
 * This used to live inside app/index.tsx, which was fine while the picker was
 * the only screen that needed it. It isn't any more: the picker's BACK ARROW
 * has to send a user to the same place the picker's rows would have, and the
 * two must never be able to disagree. One table, imported by both.
 *
 * 🔑 THIS MODULE NEVER TOUCHES STORAGE. Going "back" out of the role picker is
 * pure navigation - it must not sign anyone out, clear their saved mode, or
 * write anything. Keeping the whole back path in a module with no AsyncStorage
 * import is what makes that guarantee checkable rather than aspirational, and
 * mode.test.ts asserts it stays that way.
 */

export type Mode = "barber" | "manager" | "customer";

/** The two screens a mode can land on. */
export type ModeRoute = "/login" | "/customer";

/**
 * Where each saved mode sends the user. Barber AND manager route to /login
 * first: the dashboard is a WebView and Google blocks OAuth inside embedded
 * WebViews, so they sign in NATIVELY on /login, which hands off to /barber (the
 * dashboard WebView) once authenticated. A barber who still has their stored
 * session never SEES /login - it redirects straight through to /barber - which
 * is exactly why it is also the right target to go BACK to: it self-heals,
 * landing a signed-in barber on their dashboard and a signed-out one on the
 * sign-in screen, instead of a dashboard WebView that would only 401.
 * Manager shares the barber dashboard.
 */
export const DESTINATION: Record<Mode, ModeRoute> = {
  barber: "/login",
  manager: "/login",
  customer: "/customer",
};

/** Narrow a stored value to a Mode (ignores any legacy/garbage string). */
export function isMode(v: string | null | undefined): v is Mode {
  return v === "barber" || v === "manager" || v === "customer";
}

/**
 * Where the role picker's back arrow should go, or null if there is nowhere to
 * go back TO.
 *
 * The user's saved mode IS the record of where they came from: pressing
 * "⇄ Switch" no longer erases it (that erasure is precisely why the picker used
 * to be a dead end), so it still names the dashboard they left. That also
 * covers landing on the picker directly - a cold launch, a deep link, an OS
 * restore - because a saved mode means there is a correct default dashboard for
 * them whether or not any screen preceded this one.
 *
 * null means a genuinely first-run user: no mode has ever been chosen, so there
 * is no previous page AND no default dashboard. Showing a back arrow there
 * would be a lie, so the picker doesn't render one.
 */
export function resolveReturn(savedMode: string | null | undefined): ModeRoute | null {
  return isMode(savedMode) ? DESTINATION[savedMode] : null;
}

/**
 * Perform the "back" action. Returns whether it handled the request.
 *
 * The visible arrow and the Android hardware back button both call THIS, so the
 * two can't drift: same destination, same no-op when there's nothing behind us.
 * The boolean is what the hardware-back listener returns to the OS - true
 * ("consumed", stay in the app) when we navigated, false ("not ours") when
 * there is no dashboard to return to and quitting from the app's first screen
 * is the right behaviour.
 *
 * `navigate` is the ONLY capability this takes. It cannot sign the user out or
 * reset their role because it is handed nothing that could.
 */
export function returnToDashboard(
  savedMode: string | null | undefined,
  navigate: (href: ModeRoute) => void,
): boolean {
  const dest = resolveReturn(savedMode);
  if (!dest) return false;
  navigate(dest);
  return true;
}
