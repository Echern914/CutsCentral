import type { Metadata } from "next";
import { CancelWaitlist } from "./CancelWaitlist";

/**
 * Where the emailed "take me off the list" link lands.
 *
 * 🔑 THE LINK DOES NOT CANCEL ANYTHING BY ITSELF. It renders a confirm button,
 * and only the button POSTs. Email clients, security scanners and link
 * previewers routinely GET every URL in a message; a cancel-on-GET would have
 * people silently removed from waitlists they never left. Same reason the API
 * side is a POST.
 *
 * The token is the credential, so the page is deliberately noindex.
 */
export const metadata: Metadata = {
  title: "Leave the waitlist",
  robots: { index: false, follow: false },
};

export default function WaitlistCancelPage({
  params,
}: {
  params: { token: string };
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
      <CancelWaitlist token={params.token} />
    </main>
  );
}
