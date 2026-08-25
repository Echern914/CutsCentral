import { apiPublicGet } from "@/lib/api";
import { signupAction } from "../actions";
import { AuthForm } from "../AuthForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Create your account" };

/**
 * `searchParams` is not decoration: an invited barber reaches this page as
 * /signup?next=/team/join?token=..., and without reading it here the parameter
 * never reaches the form, never reaches signupAction, and the invitation is
 * lost the moment the account is created. The value is validated against an
 * allowlist server-side (see ../actions.ts) - nothing is trusted from here.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const [google, apple] = await Promise.all([
    apiPublicGet<{ available: boolean }>("/api/auth/google/available"),
    apiPublicGet<{ available: boolean }>("/api/auth/apple/available"),
  ]);
  return (
    <AuthForm
      mode="signup"
      action={signupAction}
      googleAvailable={google.data?.available ?? false}
      googleStartUrl="/auth/start/google"
      appleAvailable={apple.data?.available ?? false}
      appleStartUrl="/auth/start/apple"
      next={searchParams.next}
    />
  );
}
