import { redirect } from "next/navigation";

/**
 * getchairback.com/pricing is what people type (and what ads/bios link to),
 * but pricing lives as a section of the homepage. Redirect rather than 404.
 */
export default function PricingPage() {
  redirect("/#pricing");
}
