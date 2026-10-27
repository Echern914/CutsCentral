"use client";

import { APP_NAME } from "@chairback/config/constants";

/**
 * The Terms + Privacy clickwrap checkbox. ONE wording per audience, shared by
 * every place that asks it (barber signup, the dashboard's "Before you
 * continue" screen, the customer sign-in), so a change to the sentence lands
 * everywhere at once.
 *
 * Always starts unticked: the caller owns `checked` and must default it to
 * false. The links open in a new tab so reading the Terms never loses what was
 * typed into the form.
 *
 * `name` makes it a real form field (the signup server action reads it);
 * leave it off where the caller posts the answer itself.
 */
export function TermsAgreement({
  checked,
  onChange,
  audience,
  name,
  id = "terms-agreement",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** "business": barbers and their staff. "customer": My ChairBack. */
  audience: "business" | "customer";
  name?: string;
  id?: string;
}) {
  return (
    <label htmlFor={id} className="mt-1 flex items-start gap-2.5 text-xs leading-relaxed text-muted">
      <input
        id={id}
        type="checkbox"
        name={name}
        required
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
      />
      <span>
        I agree to the <DocLink href="/terms">Terms of Service</DocLink> and{" "}
        <DocLink href="/privacy">Privacy Policy</DocLink>
        {audience === "business" ? (
          <>
            {" "}
            (including the <DocLink href="/sms">SMS Messaging Policy</DocLink>). I understand{" "}
            {APP_NAME} is a business tool, not financial, tax or accounting advice, and that its
            figures are estimates that may not be accurate.
          </>
        ) : (
          "."
        )}
      </span>
    </label>
  );
}

function DocLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-gold underline-offset-2 hover:underline">
      {children}
    </a>
  );
}
