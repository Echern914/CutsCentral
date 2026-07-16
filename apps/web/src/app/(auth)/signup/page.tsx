import { API_BASE, apiPublicGet } from "@/lib/api";
import { signupAction } from "../actions";
import { AuthForm } from "../AuthForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Create your account" };

export default async function SignupPage() {
  const res = await apiPublicGet<{ available: boolean }>("/api/auth/google/available");
  return (
    <AuthForm
      mode="signup"
      action={signupAction}
      googleAvailable={res.data?.available ?? false}
      googleStartUrl={`${API_BASE}/api/auth/google/start`}
    />
  );
}
