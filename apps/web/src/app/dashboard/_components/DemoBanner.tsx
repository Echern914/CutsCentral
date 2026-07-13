import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * The read-only ribbon shown while a prospect explores the dashboard through a
 * demo session (/demo/dashboard). Sets expectations (nothing saves), sells
 * (signup CTA), and offers a clean exit that just drops the demo cookie —
 * deliberately NOT logoutAction: that bumps the shared demo owner's
 * tokenVersion server-side, which would kill every other prospect's session.
 */
export function DemoBanner() {
  async function exitDemo(): Promise<void> {
    "use server";
    cookies().delete(SESSION_COOKIE_NAME);
    const domain = sessionCookieDomain(headers().get("host"));
    if (domain) {
      cookies().set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        domain,
        maxAge: 0,
      });
    }
    redirect("/");
  }

  return (
    <div className="mx-auto mt-3 flex w-full max-w-6xl flex-col items-center justify-between gap-2 rounded-2xl border border-gold/40 bg-gold/10 px-4 py-2.5 text-xs sm:flex-row">
      <p className="text-gold">
        You&apos;re exploring the demo shop — look anywhere, nothing saves.
      </p>
      <span className="flex items-center gap-3">
        <a href="/signup" className="font-semibold text-gold hover:underline">
          Create your shop →
        </a>
        <form action={exitDemo}>
          <button className="text-muted transition-colors duration-150 ease-out hover:text-offwhite">
            Exit demo
          </button>
        </form>
      </span>
    </div>
  );
}
