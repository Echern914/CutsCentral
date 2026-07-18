import type { Metadata, Viewport } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { APP_NAME } from "@chairback/config/constants";
import { MotionConfigProvider } from "@/components/motion/MotionConfigProvider";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  // Absolute base for OG/twitter URLs - without it, sharing any page renders a
  // bare link (no card) in iMessage/Instagram/X, which is where barbers share.
  metadataBase: new URL("https://getchairback.com"),
  title: {
    default: `${APP_NAME}: loyalty & rebooking for barbershops, salons & studios`,
    template: `%s | ${APP_NAME}`,
  },
  description:
    "Automatic loyalty punch cards and perfectly-timed rebooking texts for barbershops, salons, and studios. Syncs with your Acuity or Square scheduling.",
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: `${APP_NAME}: loyalty & rebooking for barbershops, salons & studios`,
    description:
      "Automatic loyalty punch cards and perfectly-timed rebooking texts. 0% commission - you keep 100% of your revenue and own your client list.",
    url: "https://getchairback.com",
  },
  twitter: {
    card: "summary",
    title: `${APP_NAME}: keep your chair full`,
    description:
      "Automatic loyalty punch cards and perfectly-timed rebooking texts for barbershops, salons, and studios.",
  },
  // Declaring `icons` turns OFF Next's auto-injection of the icon.svg file
  // convention, so list BOTH here. The favicon (icon.svg, still served at
  // /icon.svg) plus an Apple touch icon from public/ (the apple-icon.svg file
  // convention is ignored for .svg in Next 14; iOS 16.4+ renders SVG touch
  // icons, older iOS falls back).
  icons: {
    icon: { url: "/icon.svg", type: "image/svg+xml" },
    apple: "/apple-icon.svg",
  },
};

// Without this, mobile browsers render at ~980px and zoom out - making the
// whole app tiny on phones (where barbers mostly are). Next 14 does NOT add it
// automatically; it must be an explicit export.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Brand the mobile browser chrome (address bar) charcoal to match the app.
  themeColor: "#0A0A0B",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="font-sans antialiased bg-charcoal text-offwhite">
        {/* Skip link: first focusable element, hidden until keyboard-focused, so
            keyboard/SR users can jump past nav straight to page content (WCAG 2.4.1). */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-gold focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-charcoal"
        >
          Skip to content
        </a>
        <MotionConfigProvider>
          <ToastProvider>
            {/* Skip-link target + focus anchor. NOT a <main> element: pages render
                their own <main> landmark, and nesting <main> in <main> is invalid
                HTML (two landmarks confuses SR nav). tabIndex=-1 lets the skip link
                move focus here so the next Tab lands inside the page content. */}
            <div id="main" tabIndex={-1} className="outline-none">
              {children}
            </div>
          </ToastProvider>
        </MotionConfigProvider>
        {/* Vercel Web Analytics: cookieless page-view + funnel counts (no
            consent banner needed). In production the script and beacon are
            same-origin (/_vercel/insights/*), so the CSP's script-src/
            connect-src 'self' already allow it. In local dev it points at
            va.vercel-scripts.com, which the CSP blocks - analytics simply
            doesn't run locally, which is the behavior we want anyway. */}
        <Analytics />
      </body>
    </html>
  );
}
