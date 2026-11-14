/**
 * The founder's check-in to an owner whose trial ended without picking a plan.
 * Written in his own words (from the note he sent by hand), plain text only,
 * so it reads as what it is: one person writing to another.
 */

export const TRIAL_CHECK_IN_SIGNER = "Eric";

/**
 * The name to greet by: the first word of the owner's name. Null when there is
 * nothing usable (empty, or an email address typed into the name field), so
 * the greeting falls back to "Hey there" rather than "Hey jsmith@...".
 */
export function greetingName(ownerName: string | null | undefined): string | null {
  const first = (ownerName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first === "" || first.includes("@")) return null;
  return first;
}

export function buildTrialCheckInEmail(p: { ownerName: string | null | undefined }): {
  subject: string;
  text: string;
} {
  const name = greetingName(p.ownerName);
  const text = [
    `Hey ${name ?? "there"},`,
    "",
    `This is ${TRIAL_CHECK_IN_SIGNER}, the developer of ChairBack. I saw that you finished your trial and wanted to ` +
      "ask how your experience with us was, and whether you're going to continue with us. I'd love to help with " +
      "any questions or anything that gave you trouble. Let me know if you need anything.",
    "",
    "Best,",
    TRIAL_CHECK_IN_SIGNER,
  ].join("\n");
  return { subject: "Your experience on ChairBack", text };
}
