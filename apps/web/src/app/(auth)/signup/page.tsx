import { API_BASE, apiPublicGet } from "@/lib/api";
import { signupAction } from "../actions";
import { AuthForm } from "../AuthForm";

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
