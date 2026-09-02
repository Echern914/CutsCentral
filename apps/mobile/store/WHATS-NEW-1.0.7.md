# What's New — 1.0.7 (build 38)

Previous release: **1.0.6 = build 36, cut from `f60b3c5`** (2026-08-25). Build 37
(1.0.6 again, `286c79b`) was built but Apple refused the upload: a version string
that was already submitted cannot take another build. 1.0.7 exists to carry it.
This release: everything merged to `main` after `f60b3c5`.

## Paste into App Store Connect → "What's New in This Version"

```
New in this version:

• Find your shop by its exact name — type it in, or open the link your barber sent, and you're in. Nobody else's shop comes up.
• Sign in for rewards with your phone number. Your verified number is your account, so a new phone or a lost link never loses your visits.
• See your rewards tier, how far you are from the next one, and what each tier gets you at your shop.
• Book a standing appointment — pick your usual time and it's yours for the weeks ahead. Cancel one visit, or all of them, from a single link.
• Creating an account opens in your browser and brings you straight back signed in.

Also new since the last release:

• A fresh front door that fits every kind of shop, not just barbers
• Holiday and special-date pricing shows up before you book, not after
• Booking confirmations by email, with a calendar file attached
• Your barber's text assistant now quotes the exact price and time for the slot it offers
```

## Honesty note for whoever ships this

Only the items that touch `apps/mobile` are changes to the app binary. The
rest is web and reaches users through the WebView without an app update -
someone still on build 36 already has it. Listing them is fine (release notes
describe the product); describing them as fixes to the app itself is not, which
is why the copy never says "we fixed".

No prices, no plans, no purchase CTAs, no "free payments", no competitor
mentions - the same rules as the listing (see LISTING.md).

## The 94 commits in this release

Binary (6, touch `apps/mobile`):
- `dd6f9b0` feat(customer): find your shop by its exact name (#373)
- `896dde6` feat(booking): holiday date RANGES + a vertical-neutral app front door (#358)
- `7f4ed28` feat(business-type): no hard-coded barbershop copy, and a guard that keeps it that way (PR 4) (#353)
- `e5710d1` feat(rewards): phone recovery - the verified phone is the identity (PR 2) (#340)
- `9744146` feat(walk-in): notifications, the end-of-day sweep, and the owner's switchboard (PR 4) (#328)
- `f0fb850` feat(mobile): a sign-up door that opens the browser and comes back signed in (#314)

Web / API (88, visible in the app's WebView):
- `c176df6` feat(booking): a customer can cancel the rest of a standing appointment (#376)
- `7223a34` fix(receptionist): say only what the shop actually does (#375)
- `286c79b` feat(booking): a customer can book a standing appointment (#374)
- `ba79f83` feat(rewards): tier bar, tier perks, and one-tap rebook (#372)
- `225ef39` test(referral): prove the CAS is what stops a double payout (#371)
- `5bbf589` feat(mcp): the connector answers as well as the app does (PR 2) (#370)
- `5d3662c` fix(booking): hold the chair while they pay, confirm when the money lands (#369)
- `3fc984f` fix(receptionist): stop the policy copy promising money it never takes (#368)
- `c4dfc4e` docs: the traps that cost this session real time (#366)
- `78cf439` test(concurrency): make race tests fail when their guard is removed (#367)
- `f1dff78` feat(support): one support brain, and the knowledge it was missing (PR 1) (#365)
- `f26e0c1` feat(support): evaluation and observability foundation for support intelligence (PR 0) (#364)
- `96fd9a7` feat(affiliate): qualification lifecycle, owner lock, cross-ledger boundary (PR 3) (#363)
- `0211635` feat(affiliate): durable attribution from referral link to shop creation (PR 2) (#362)
- `3db4403` feat(affiliate): program foundation - policy, schema, lifecycle, admin review (PR 1) (#361)
- `1d1de1e` fix(referrals): stop handing the referrer the referred shop's name (#360)
- `daab340` feat(payments): let a barber link the Stripe account they already have (#359)
- `4b0cf78` fix(assistant): state ChatGPT's real connector requirement before someone tries (#354)
- `3fcc786` feat(booking): Drick round 4 - filled windows, no special-vs-special veto, multi-date holidays (#357)
- `6171480` feat(email): Apple Wallet appointment pass + Add to Calendar + app CTA (#356)
- `ae03313` fix(email): reliable transactional mail + the cancellation email that never existed (#352)
- `4fe307a` fix(dashboard): stop the home screen dying on a server-side useVocab() call (#355)
- `2c27a22` feat(business-type): change it later, and close the ungated path (PR 3) (#351)
- `4e5c2f7` feat(business-type): the API and public surfaces speak the shop's language (PR 2) (#350)
- `ec0854a` feat(business-type): the vertical registry and vocabulary resolver (PR 1) (#348)
- `fcd7ffb` feat(ops): say which build is live (#347)
- `fb5f5a3` feat(booking): make a turned-away customer visible (#346)
- `7544769` fix(booking): tell the customer what actually happened (#345)
- `b9d9de4` fix(booking): accept the slot the picker actually offered (#344)
- `3637c19` feat(rewards): credential hygiene + durable link rotation (PR 4) - HELD (#343)
- `947cbb5` feat(rewards): open the phone-recovery door on every customer surface (PR 3) (#342)
- `74b4693` feat(rewards): give a barber their own clients, and the link to hand back (#341)
- `a5be2b1` feat(rewards): let a barber resend a client's rewards link (#339)
- `ec88043` feat(ops): let the preflight see the half of the deployment it was blind to (#338)
- `25a51c2` feat(web): offer the app on the pages customers actually land on (#337)
- `6e8a59c` test(referral): cover the Stripe credit branch, and make a failed grant impossible to miss (#336)
- `6add621` feat(kiosk): refuse to mint a kiosk URL for a shop that cannot serve anyone (#335)
- `ee924f0` fix(kiosk): say "not set up yet" instead of showing a dead Next button (#334)
- `5787a53` fix(waitlist): stop the audit log mistaking our own record ids for phone numbers (#333)
- `d0d53af` docs(test): correct the receptionist mirror-clock note that #329 reversed (#332)
- `3ae0b2a` fix(test): give acuityBackfill's default appointments their own instant (#331)
- `9b76bbd` feat(walk-in): Live Queue, service start, and completion on the books (PR 3) (#327)
- `e1f0832` feat(walk-in): kiosk check-in and private queue tracking (PR 2) (#326)
- `d5efec5` fix(walk-in): stop the audit log mistaking our own record ids for phone numbers (#330)
- `d9bf5ba` feat(walk-in): the same-day queue domain, lifecycle engine, and estimates (PR 1) (#325)
- `f33aeb2` fix(mirror): make the outbound mirror's clock injectable, and stop the tests rotting on 2026-09-10 (#329)
- `a43f98d` feat(dashboard): Insights returns to the tab bar, the Assistant moves to the corner (#324)
- `ed41579` fix(mcp): accept form-encoded bodies on the token and revocation endpoints (#323)
- `2321cf8` fix(mcp): say WHY a connection was refused instead of "try again" (#322)
- `20ffa01` fix(mcp): keep the authorization request alive across the login redirect (#321)
- `66ee9e6` feat(assistant): a real step-by-step for connecting an AI assistant (#320)
- `1eea033` feat(mcp): the connection panel — see what can read your shop, and cut it off (#319)
- `3b08910` feat(mcp): ten read-only tools behind one default-deny policy matrix (PR C) (#318)
- `bf826f1` fix(mcp): enforce outer rate limit and isolate authorization-code replay (#317)
- `a12e451` feat(readiness): tell a shop when Acuity is connected but broken (#316)
- `001875d` feat(mcp): remote MCP server — authorization foundation (PR B) (#315)
- `0b24129` feat(assistant): one feature registry, and the tab that reads it (#313)
- `b78d0be` feat(dashboard): a bell for the things already waiting on you (#312)
- `aacb690` feat(book): move the page to the step the customer just unlocked (#311)
- `205d790` fix(booking): one band for four identical Acuity blocks (#310)
- `fadb331` feat(booking): take back a cancel, and clear the dead rows off the day (#309)
- `fb57a8d` feat(booking): pin the day's total to the top of the day (#308)
- `a0cffae` feat(booking): a week you can see, and days you can swipe between (#307)
- `9eff93d` fix(booking): stop the calendar lying for ten seconds after every write (#306)
- `83949ae` feat(booking): the add and block-off forms join the sheet's design system (#305)
- `2e254b0` feat(waitlist): Gold sorts to the front of the same queue (B) (#294)
- `c55d62b` feat(waitlist): an entry now knows its client, and one list drives the scan's order (#292)
- `d414b7a` fix(waitlist): the claim route hung on an unmapped chair - answer, and make the next one a build error (#304)
- `698eb76` fix(booking): the sheet on a phone — keyboard, scroll position, collapsed cards (#291)
- `116beec` fix(sentry): scrub events with the log stream's rule, and report the two silent failures (#301)
- `a8103f2` fix(mirror): stop an unmapped chair breaking five booking paths (#295)
- `8d510fe` fix(acuity): stop the webhook secret coming back out through a log (#300)
- `6b719b7` fix(logs): the session cookie was on stdout - redact the response headers too (#298)
- `b420327` fix(logs): stop 21 routes writing their bearer token into every log line (#297)
- `d8f1d84` feat(booking): rebuild the appointment sheet around one row of actions (#290)
- `d82e56e` feat(booking): one appointment sheet that tells the truth about contact and money (#287)
- `9a48971` feat(acuity): protect the bookings that existed before the mirror did (#286)
- `e6aa088` feat(help): answer the 22 questions barbers were texting Eric instead (#285)
- `43fee1e` fix(api): mint the fallback shop slug from base36, not base64url (#284)
- `80bf0eb` fix(shops): a slug minted after 98 name collisions was unreachable forever (#281)
- `921296d` fix(dashboard): stop the top bar pushing the page 6px wide at 768 (#282)
- `4a6f1e5` feat(home): give the action row room, and a way to hand over the link (#280)
- `46638bc` feat(booking): put the waitlist one tap from the day being worked (#279)
- `cde94c4` fix(booking): type the edit sheet's toast the way its siblings do (#278)
- `7fd6fe5` feat(readiness): centralized read-only launch-readiness engine (PR B1) (#271)
- `54ba4c2` feat(booking): edit an appointment, and say what its status actually is (#277)
- `47dc2da` feat(acuity): mirror every booking path, with per-barber enforcement safety (#275)
- `94bf6bf` feat(acuity): map each chair to its Acuity calendar (outbound foundation) (#273)
