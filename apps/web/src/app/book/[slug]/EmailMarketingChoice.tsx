"use client";

/**
 * "Email me news and offers from <shop>" - the customer's own yes to the
 * shop's marketing email, and the only one the booking page can record.
 *
 * 🔴 UNTICKED UNTIL THEY TICK IT. A pre-ticked box is not a yes, and a yes is
 * the only thing that lets the shop's email broadcasts reach anyone. Shown
 * only once an email is entered: without an address there is nothing to say
 * yes for. Appointment emails come either way; this is not about them.
 */
export function EmailMarketingChoice({
  email,
  shopName,
  checked,
  onChange,
}: {
  email: string;
  shopName: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (!email.trim()) return null;
  return (
    <label className="flex items-start gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
        data-qa="email-marketing"
      />
      <span>Email me news and offers from {shopName}. You can unsubscribe anytime.</span>
    </label>
  );
}

/**
 * What the booking sends for it: true only for a tick WITH an address to go
 * with it, and otherwise nothing at all - an absent field changes nothing.
 */
export function emailMarketingYes(ticked: boolean, email: string): true | undefined {
  return ticked && email.trim() ? true : undefined;
}
