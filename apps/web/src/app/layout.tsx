import type { Metadata } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { APP_NAME } from "@chairback/config/constants";
import { MotionConfigProvider } from "@/components/motion/MotionConfigProvider";
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
  title: APP_NAME,
  description: "Loyalty & rebooking for barbershops.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="font-sans antialiased bg-charcoal text-offwhite">
        <MotionConfigProvider>{children}</MotionConfigProvider>
      </body>
    </html>
  );
}
