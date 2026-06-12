# Legal & Liability Checklist

The repo now ships three public legal pages — `/terms`, `/privacy`, `/sms` — plus
clickwrap on signup and footer links. **Documents alone are not full protection.**
This file is the rest of the to-do list, in priority order.

> These documents were drafted with AI assistance, not by a lawyer. They are a
> strong starting point, but before (or shortly after) real customers sign up,
> have a U.S. attorney review them — especially the arbitration clause, the
> liability cap, and the TCPA/consent allocation. A flat-fee startup-terms
> review is typically a few hundred dollars and is the single best money you
> can spend here.

## 1. Form an LLC (the #1 liability protection)

Nothing in a Terms of Service protects your personal assets if ChairBack is a
sole proprietorship — an LLC does. Until then, *you personally* are the
counterparty to every contract and lawsuit.

- [ ] Form an LLC (Delaware home-state filing is simplest if you live there:
      one filing, no foreign-qualification; ~$110 + ~$300/yr franchise tax,
      plus a registered agent if you don't use your own address).
- [ ] Get an EIN (free, irs.gov, 10 minutes).
- [ ] Open a separate business bank account and run all ChairBack money
      through it (mixing personal/business funds can "pierce the veil" and
      undo the LLC's protection).
- [ ] Re-register accounts under the LLC: Twilio, Vercel, Railway, Supabase,
      Namecheap, Acuity dev account, Google Cloud.
- [ ] Update `LEGAL_ENTITY` in `apps/web/src/components/legal/Legal.tsx` from
      "ChairBack" to the LLC's exact legal name (e.g. "ChairBack LLC"), and
      bump the effective date.

## 2. Insurance (when there's revenue or real usage)

- [ ] **Cyber liability + Tech E&O** policy (often sold together; covers data
      breaches, and claims that your software caused customer losses —
      including defense costs, which are the real killer). Hiscox, Vouch,
      Embroker sell small-startup policies.
- [ ] General liability is mostly irrelevant for a SaaS with no office/foot
      traffic; prioritize cyber/E&O.

## 3. TCPA / SMS — the biggest concrete legal risk in this product

TCPA damages are $500–$1,500 *per text*, and plaintiffs' firms actively troll
SMS programs. The Terms push consent responsibility onto shops (correct), but
you still want the platform to be defensible:

- [x] STOP/HELP keywords handled; opt-out enforced platform-wide per phone
      number (`webhooks.twilio.ts`).
- [x] "Reply STOP to opt out" auto-appended to every template.
- [x] Daily send caps per shop.
- [ ] When registering the Twilio A2P 10DLC campaign, use these URLs:
      privacy = `https://getchairback.com/privacy` (contains the required
      "no mobile information shared with third parties for marketing" clause),
      terms = `https://getchairback.com/sms`. Register against the final
      domain, not the Railway URL (already in GO-LIVE.md).
- [ ] Consider adding an in-dashboard consent attestation when a shop first
      enables messaging ("I confirm I have my clients' consent to text
      them...") — one checkbox + a timestamp column = strong evidence later.
- [ ] Keep Nudge rows forever (they're your delivery/consent audit trail —
      don't add a cleanup job that deletes them).
- [ ] Quiet hours: TCPA safe harbor is 8am–9pm *recipient local time*. The
      nudge scheduler should avoid sending outside that window for the shop's
      timezone (clients are nearly always local to the shop). Verify before
      flipping DRY_RUN=false.

## 4. Privacy-policy accuracy (a policy that overstates = FTC exposure)

The policy promises only what the code does today. If any of these change,
update `/privacy` **before** shipping:

- Adding analytics (PostHog/GA), ad pixels, or any third-party JS → cookie
  section is currently "one session cookie, no trackers".
- Adding email sending (the EMAIL channel seam) → add the provider as a
  subprocessor.
- Adding Stripe billing → add Stripe + payment-data language.
- Adding image uploads (roadmap #5) → add the storage provider (e.g. Supabase
  Storage / S3) as a subprocessor.
- New subprocessors of any kind → update the list in Section 5.

## 5. Operational items

- [ ] Create the `support@getchairback.com` mailbox/forward (Namecheap free
      email forwarding) — it's the contact address in all three documents and
      the HELP contact for SMS. **Do this before deploying the pages.**
- [ ] Data-deletion path: be able to actually delete a shop + its client data
      on request (the policy promises it). Manual via Prisma is fine for now;
      note that opt-out records should be preserved.
- [ ] Breach-response basics: Sentry/alerting (already roadmap #5), and know
      that all 50 states have breach-notification laws — if client phone
      numbers/emails leak, notification duties are triggered. Your cyber
      policy (item 2) typically runs this process for you.
- [ ] Versioning: when you materially change /terms or /privacy, bump
      `LEGAL_EFFECTIVE_DATE` and email shop owners. Keep old versions in git
      history (this repo already does that for free).

## 6. Later / nice-to-have

- [ ] DMCA designated-agent registration with the Copyright Office (~$6) once
      shops upload images — gives safe-harbor against copyright claims over
      shop-uploaded photos.
- [ ] A lightweight DPA (data-processing addendum) for shops that ask;
      Section 4 of the Terms already contains processor language, which is
      enough for small shops.
- [ ] If you ever take clients outside the U.S., revisit GDPR/Quebec Law 25 —
      the documents currently scope the service to U.S. businesses on purpose.
- [ ] Trademark search/registration for "ChairBack" before spending on brand.

## What the documents already do for you

- **Terms**: warranty disclaimer (AS IS), liability cap ($100 / 12-mo fees),
  consequential-damages exclusion, shop indemnifies you for TCPA claims,
  client-data consent, rewards/promotions, and uploaded content; arbitration +
  class-action waiver (with 30-day opt-out, which improves enforceability);
  Delaware law/venue; clickwrap acceptance at signup.
- **Privacy**: dual controller/processor roles, the exact no-mobile-data-
  sharing language Twilio A2P reviewers look for, subprocessor list matching
  the real stack, security description matching the real implementation
  (argon2id, AES-256-GCM, RLS), state-privacy-rights section, children/COPPA.
- **SMS policy**: program description, opt-in description, frequency,
  "msg & data rates", STOP/HELP, carrier non-liability — the standard CTIA
  disclosure set carriers expect at a public URL.
