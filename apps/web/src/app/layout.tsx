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
  title: {
    default: `${APP_NAME}: loyalty & rebooking for barbershops`,
    template: `%s | ${APP_NAME}`,
  },
  description:
    "Automatic loyalty punch cards and perfectly-timed rebooking texts for barbershops. Built on top of your Acuity scheduling.",
};

// Without this, mobile browsers render at ~980px and zoom out - making the
// whole app tiny on phones (where barbers mostly are). Next 14 does NOT add it
// automatically; it must be an explicit export.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
