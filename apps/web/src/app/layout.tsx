import type { Metadata, Viewport } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
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
        <MotionConfigProvider>
          <ToastProvider>{children}</ToastProvider>
        </MotionConfigProvider>
      </body>
    </html>
  );
}
