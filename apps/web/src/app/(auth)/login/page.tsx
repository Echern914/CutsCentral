import { apiPublicGet } from "@/lib/api";
import { loginAction } from "../actions";
import { AuthForm } from "../AuthForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Sign in" };

const ERROR_COPY: Record<string, string> = {
  google_state: "Google sign-in expired. Please try again.",
  google_failed: "Google sign-in didn't go through. Please try again.",
  google_email_unverified:
    "That Google account's email isn't verified yet. Verify it with Google, then try again.",
  apple_state: "Apple sign-in expired. Please try again.",
  apple_failed: "Apple sign-in didn't go through. Please try again.",
  apple_email_unverified:
    "That Apple ID's email isn't verified yet. Verify it with Apple, then try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  // Capability discovery, same pattern for both: the API says what's
  // configured, the form only renders entry points that will actually work.
  const [google, apple, forgot] = await Promise.all([
    apiPublicGet<{ available: boolean }>("/api/auth/google/available"),
    apiPublicGet<{ available: boolean }>("/api/auth/apple/available"),
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
      googleStartUrl="/auth/start/google"
      appleAvailable={apple.data?.available ?? false}
      appleStartUrl="/auth/start/apple"
      forgotPasswordAvailable={forgot.data?.available ?? false}
      initialError={initialError}
      next={searchParams.next}
    />
  );
}
