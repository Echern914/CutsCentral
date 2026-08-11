/**
 * NOTE: deliberately NOT a "use client" module. The browser APIs are only
 * touched inside function bodies, so server components may import the
 * constants (the dashboard layout inlines PREPAINT_SCRIPT into a <script>),
 * while the client components import the functions.
 *
 * Dashboard appearance: "dark" (black & gold, the original) or "light" (white
 * & gold). The mechanism is one attribute - data-theme on <html> - which remaps
 * every CSS token variable (globals.css) that the Tailwind palette resolves to.
 *
 * WHERE IT APPLIES, deliberately: only the barber-facing surfaces (/dashboard,
 * /onboarding). Client-facing pages (/s, /book, /r, /demo) and the marketing
 * site always render the brand's dark look - a client booking a haircut sees
 * the SHOP's branding, never the barber's personal reading preference, and a
 * barber previewing their own public page must see what clients see.
 *
 * Source of truth is User.theme on the API; localStorage is the fast local echo
 * that lets a pre-paint script apply the theme before hydration (no dark flash
 * for light users on a hard load).
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "cb-theme";

/** Routes that honor the personal theme. Everything else is brand-dark. */
export function themeableRoute(pathname: string): boolean {
  return pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding");
}

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Set the attribute (the visual flip) and remember the choice locally. */
export function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage denied (private mode) - the attribute still applied */
  }
}

/** Drop to brand-dark WITHOUT forgetting the preference (public routes). */
export function suspendTheme(): void {
  delete document.documentElement.dataset.theme;
}

/**
 * Inline pre-paint script (dashboard/onboarding layouts): applies the stored
 * theme before first paint so a light-mode barber never sees a dark flash.
 * Kept tiny + try/catch'd; the default (no attribute) is dark = today's look.
 */
export const PREPAINT_SCRIPT = `try{if(localStorage.getItem("${STORAGE_KEY}")==="light")document.documentElement.dataset.theme="light"}catch(e){}`;
