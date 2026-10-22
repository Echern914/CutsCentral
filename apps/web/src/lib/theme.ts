/**
 * NOTE: deliberately NOT a "use client" module. The browser APIs are only
 * touched inside function bodies, so server components may import the
 * constants (the dashboard layout inlines PREPAINT_SCRIPT into a <script>),
 * while the client components import the functions.
 *
 * Appearance: "light" (warm white & gold) is ChairBack's MAIN look, everywhere
 * - the landing page, sign-in, booking, every page (Eric, 2026-10-17). "dark"
 * (the original black & gold) is a personal choice a barber can make for
 * their own dashboard. The mechanism is one attribute - data-theme="dark" on
 * <html> - which remaps every CSS token variable (globals.css). No attribute
 * = light, so a page renders light from its very first paint.
 *
 * WHERE THE CHOICE APPLIES, deliberately: only the barber-facing surfaces
 * (/dashboard, /onboarding). Every other page renders light whatever the
 * barber picked: a client booking a haircut sees ChairBack's look, never the
 * barber's personal reading preference, and a barber previewing their own
 * booking page sees what clients see. (A shop's own page design on /s keeps
 * its own colours - that is the shop's branding, set in its page settings.)
 *
 * Source of truth is User.theme on the API; localStorage is the fast local echo
 * that lets a pre-paint script apply dark before hydration (no light flash
 * for dark users on a hard load).
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "cb-theme";

/** Routes that honor the personal theme. Everything else is light. */
export function themeableRoute(pathname: string): boolean {
  return pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding");
}

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Inside the iPhone app, say which theme is showing so the app can colour the
 * status bar to match (apps/mobile AppWebView, "cb:theme:*"). Silent in a
 * browser, and in an older app that ignores the message.
 */
function tellApp(theme: Theme): void {
  try {
    (window as { ReactNativeWebView?: { postMessage: (m: string) => void } }).ReactNativeWebView?.postMessage(
      `cb:theme:${theme}`,
    );
  } catch {
    /* no bridge */
  }
}

/** Set the attribute (the visual flip) and remember the choice locally. */
export function applyTheme(theme: Theme): void {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  tellApp(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage denied (private mode) - the attribute still applied */
  }
}

/**
 * A public page that wears its SHOP'S colours rather than ChairBack's: the
 * booking page of a shop whose own page is dark (Drick, 2026-10-22: "Any way
 * i can switch it to black? Not sure why it's white now"). The page marks
 * itself with this attribute (components/PageScheme.tsx); the marker, not the
 * route, decides, so leaving the page drops the dark with it.
 */
export const PAGE_SCHEME_ATTR = "data-page-scheme";

function pageWantsDark(): boolean {
  return document.querySelector(`[${PAGE_SCHEME_ATTR}="dark"]`) !== null;
}

/**
 * Pre-paint for a page that wears a dark shop scheme: the attribute is on
 * <html> before the first paint, so a hard load never flashes white.
 */
export const PAGE_DARK_PREPAINT_SCRIPT = `document.documentElement.dataset.theme="dark"`;

/** Set the shop's dark on <html> for the page that asked (never stored). */
export function wearPageDark(): void {
  document.documentElement.dataset.theme = "dark";
  tellApp("dark");
}

/**
 * Back to the main (light) look WITHOUT forgetting the preference (public
 * routes) - unless the page on screen wears its shop's dark scheme, which is
 * the shop's branding, not the barber's personal preference.
 */
export function suspendTheme(): void {
  if (pageWantsDark()) {
    wearPageDark();
    return;
  }
  delete document.documentElement.dataset.theme;
  tellApp("light");
}

/**
 * Inline pre-paint script (dashboard/onboarding layouts): applies a stored
 * dark choice before first paint so a dark-mode barber never sees a light
 * flash. Kept tiny + try/catch'd; the default (no attribute) is light.
 */
export const PREPAINT_SCRIPT = `try{if(localStorage.getItem("${STORAGE_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;
