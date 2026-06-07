import { API_BASE, apiPublicGet } from "@/lib/api";
import { loginAction } from "../actions";
import { AuthForm } from "../AuthForm";

export default async function LoginPage() {
  const res = await apiPublicGet<{ available: boolean }>("/api/auth/google/available");
  return (
    <AuthForm
      mode="login"
      action={loginAction}
      googleAvailable={res.data?.available ?? false}
      googleStartUrl={`${API_BASE}/api/auth/google/start`}
    />
  );
}
