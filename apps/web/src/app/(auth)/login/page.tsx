import { API_BASE, apiPublicGet } from "@/lib/api";
import { loginAction } from "../actions";
import { AuthForm } from "../AuthForm";

const ERROR_COPY: Record<string, string> = {
  google_state: "Google sign-in expired. Please try again.",
  google_failed: "Google sign-in didn't go through. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  const res = await apiPublicGet<{ available: boolean }>("/api/auth/google/available");
  const initialError = searchParams.error
    ? (ERROR_COPY[searchParams.error] ?? "Sign-in failed. Please try again.")
    : undefined;
  return (
    <AuthForm
      mode="login"
      action={loginAction}
      googleAvailable={res.data?.available ?? false}
      googleStartUrl={`${API_BASE}/api/auth/google/start`}
      initialError={initialError}
      next={searchParams.next}
    />
  );
}
