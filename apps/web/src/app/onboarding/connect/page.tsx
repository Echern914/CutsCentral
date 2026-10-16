import { redirect } from "next/navigation";

/** The old "Connect your booking" step is now "How do clients book you?". */
export default function ConnectPage() {
  redirect("/onboarding/booking");
}
