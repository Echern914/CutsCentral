import { API_BASE, apiPublicGet } from "@/lib/api";
import { loginAction } from "../actions";
import { AuthForm } from "../AuthForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Sign in" };

const ERROR_COPY: Record<string, string> = {
  google_state: "Google sign-in expired. Please try again.",
  google_failed: "Google sign-in didn't go through. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  // Capability discovery, same pattern for both: the API says what's
  // configured, the form only renders entry points that will actually work.
  const [google, forgot] = await Promise.all([
    apiPublicGet<{ available: boolean }>("/api/auth/google/available"),
    apiPublicGet<{ available: boolean }>("/api/auth/password-reset/available"),
  ]);
  const initialError = searchParams.error
    ? (ERROR_COPY[searchParams.error] ?? "Sign-in failed. Please try again.")
    : undefined;
  return (
    <AuthForm
      mode="login"
      action={loginAction}
      googleAvailable={google.data?.available ?? false}
      googleStartUrl={`${API_BASE}/api/auth/google/start`}
      forgotPasswordAvailable={forgot.data?.available ?? false}
      initialError={initialError}
      next={searchParams.next}
    />
  );
}
