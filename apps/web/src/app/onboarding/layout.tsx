/**
 * Onboarding group layout. Exists to give the client-component onboarding page
 * a distinct document title (WCAG 2.4.2) — "use client" pages can't export
 * metadata themselves. The connect/done steps override with their own titles.
 */
export const metadata = { title: "Set up your shop" };

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
