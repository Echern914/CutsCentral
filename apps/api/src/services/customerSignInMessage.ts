/**
 * What a sign-in code actually says, on each channel.
 *
 * Its own module so that the service which MINTS a challenge and the worker
 * which DELIVERS it can both render it without importing each other. Pure
 * functions: no database, no provider, no environment - which is also what
 * lets a test pin the text and its segment count directly.
 */

export function signInSmsBody(code: string): string {
  // GSM-7 only, one segment; pinned by a segment test. iOS offers the code
  // straight from the keyboard because the text names it a code.
  return `ChairBack code: ${code}. Use it to sign in to My ChairBack. Expires in 5 minutes. Reply STOP to opt out.`;
}

export function signInEmail(code: string): { subject: string; text: string; html: string } {
  const subject = `Your ChairBack code: ${code}`;
  const text = [
    `Your My ChairBack sign-in code is ${code}.`,
    "",
    "It expires in 5 minutes. If you didn't ask for it, you can ignore this email - nobody can sign in without the code.",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#17171b;">
<p style="margin:0 0 16px;font-size:15px;">Your My ChairBack sign-in code:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;">${code}</p>
<p style="margin:0;font-size:13px;color:#5a5a62;">It expires in 5 minutes. If you didn't ask for it, you can ignore this email - nobody can sign in without the code.</p>
</div>`;
  return { subject, text, html };
}
