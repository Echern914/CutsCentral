# What's New — 1.1.8 (build 55)

Previous release: **1.1.7 = build 54**. 1.1.8 carries the app changes merged
since then; see `docs/release-1.1.8.md`.

## Paste into App Store Connect → "What's New in This Version"

```
Booked for more than one person? Appointments made together, like you and your kids, now show as one card. Tap it to see each appointment.

Can't find your rewards link? On Connect your profile, tap "Email me my link" and it goes to the email your shop has for you.

Creating your account now asks you to agree to the Terms of Service and Privacy Policy before your code is sent.
```

## Paste into App Review Information → Notes (append to what is there)

```
New in 1.1.8: on the business side, the "Manage plan on getchairback.com" link opens our website in Safari, where the business manages its subscription. No prices or purchase buttons are shown inside the app. ChairBack is distributed on the United States storefront only.
```

The note is there so a reviewer who meets the Safari hand-off knows it is the
US external-link allowance and not an in-app purchase. If App Review objects
anyway, turning `NATIVE_EXTERNAL_BILLING_LINK` off in
`packages/config/src/features.ts` removes the link from the app with a web
deploy. No new build is needed.
