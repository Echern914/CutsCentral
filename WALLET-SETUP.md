# Apple Wallet punch card — go-live steps

The code ships DARK: until all five `WALLET_*` env vars are set on the Railway
API service, the rewards page hides its Add-to-Wallet button and every wallet
route 404s (the Stripe/Resend/VAPID pattern). These are the one-time steps only
the Apple account holder can do (~15 minutes).

## 1. Create the Pass Type ID (Apple Developer portal)

1. developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers**
   → `+` → **Pass Type IDs**.
2. Description: `ChairBack punch card`. Identifier: **`pass.com.getchairback.rewards`**.
3. Register.

## 2. Create + download the certificate

1. Open the new Pass Type ID → **Create Certificate**.
2. It asks for a CSR. On the Mac: Keychain Access → Certificate Assistant →
   *Request a Certificate From a Certificate Authority…* → your email, common
   name `ChairBack Pass`, **Saved to disk**.
3. Upload the CSR, download the issued `pass.cer`, double-click to install it
   into Keychain.

## 3. Export to PEM

In Keychain Access find the `Pass Type ID: pass.com.getchairback.rewards`
certificate, expand it, select BOTH the cert and its private key → right-click
→ Export → `wallet.p12` (pick an export password). Then in Terminal:

```sh
# the signing certificate
openssl pkcs12 -in wallet.p12 -clcerts -nokeys -legacy -out wallet-cert.pem
# the private key (set/keep a passphrase, or add -nodes for none)
openssl pkcs12 -in wallet.p12 -nocerts -legacy -out wallet-key.pem
# Apple's WWDR G4 intermediate
curl -sO https://www.apple.com/certificatesauthority/AppleWWDRCAG4.cer
openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
```

## 4. Set the Railway env (API service: loving-communication / @chairback/api)

```sh
WALLET_PASS_TYPE_ID=pass.com.getchairback.rewards
WALLET_TEAM_ID=<your 10-char Apple Team ID>
WALLET_PASS_CERT_BASE64=$(base64 -i wallet-cert.pem)
WALLET_PASS_KEY_BASE64=$(base64 -i wallet-key.pem)
WALLET_PASS_KEY_PASSPHRASE=<the key passphrase, if you set one>
WALLET_WWDR_CERT_BASE64=$(base64 -i wwdr.pem)
```

Redeploy the API. That's it — no web env needed (the page reads
`wallet.available` from the API).

## 5. Verify

1. `curl -sI https://api.getchairback.com/api/rewards/<a-magic-token>/wallet-pass`
   → `200` + `Content-Type: application/vnd.apple.pkpass` (it's `404` while dark).
2. Open a rewards link in iOS **Safari** (not the app) → "Add to Apple Wallet"
   badge appears → tap → the pass sheet shows the punch card → Add.
3. Punch a visit for that client in the dashboard → within seconds the pass in
   Wallet updates its balance (this is the APNs poke + re-fetch loop; check
   Railway logs for `wallet pass poke` warnings if it doesn't).

## Notes

- The SAME certificate signs passes and authenticates the update pokes to APNs.
  It expires yearly - Apple emails you; renew in the portal and refresh the two
  BASE64 vars.
- The button intentionally does NOT show inside the iOS app's WebView (WKWebView
  can't present the Add-Pass sheet from a plain navigation). Customers add it
  from their SMS rewards link in Safari. In-app add is a small follow-up
  (intercept the .pkpass URL in AppWebView → hand to the OS).
- Kill switch: unset any WALLET_* var and everything goes dark again; passes
  already in Wallet stay but stop updating.

---

# Appointment pass (second pass type) — go-live steps

"Add to Apple Wallet" for the BOOKING itself: an eventTicket showing the date,
time, service and barber, which updates itself on reschedule and greys out
(voids) on cancellation. It is offered in THREE places, all gated on the same
three vars below:

- the **confirmation email**;
- the **booking confirmation screen**, under "View / change my appointment";
- the **customer's home** (`/r/<magicToken>`), under their next appointment.

A pass is never offered for a booking still awaiting the barber's approval —
a pass saying someone has an appointment they do not yet have is worse than no
pass — and the badge never renders outside iOS Safari, nor inside the app's
WebView, where WKWebView cannot present the Add-Pass sheet. It is a SEPARATE Pass Type ID
from the punch card — Apple binds each certificate to exactly one type id — so
it needs its own identifier + certificate, but reuses the same Team ID and WWDR
intermediate you already exported above.

Ships DARK: until the three `WALLET_APPT_*` vars are set, all three surfaces
hide the button and every appointment-pass route 404s (never 500 — see
`appointmentWalletDisabled.test.ts`, which pins the fail-closed state).
Switching it on touches nothing about the punch card. "Add to Calendar" (.ics) does NOT
depend on any of this — it works from the moment the code deploys.

## 1. Create the second Pass Type ID

developer.apple.com → Identifiers → `+` → **Pass Type IDs** →
Description: `ChairBack appointment`. Identifier:
**`pass.com.getchairback.appointment`** → Register.

## 2–3. Certificate + PEM export

Same certificate steps as the punch card, against the NEW Pass Type ID. Export
the cert **and** its private key from Keychain as `wallet-appt.p12`, then:

```sh
# the signing certificate
openssl pkcs12 -in wallet-appt.p12 -clcerts -nokeys -legacy -out wallet-appt-cert.pem
# the private key - UNENCRYPTED. `-nodes` is not optional here; see below.
openssl pkcs12 -in wallet-appt.p12 -nocerts -nodes -legacy -out wallet-appt-key.pem
```

(The WWDR file is the same one — no need to re-download.)

### 🔴 The key must be an UNENCRYPTED PEM. Use `-nodes`.

This is the one supported path, and it is the one production already runs on:
the live punch card has **no `WALLET_PASS_KEY_PASSPHRASE` set** — only the five
other `WALLET_*` vars — so its key is unencrypted and proven working.

**Without `-nodes`, `openssl pkcs12 -nocerts` prompts you for a NEW PEM pass
phrase and always writes an encrypted key.** That key then fails to load unless
`WALLET_APPT_PASS_KEY_PASSPHRASE` is also set, and the failure surfaces at
signing time — long after the deploy looked fine. Earlier revisions of this doc
called the passphrase "optional", which was wrong in the only way that matters:
following the command as written *forced* a passphrase the env then lacked.

The key is consumed in two places and both take the same PEM:
`decodeWalletCerts` (`wallet/pass.ts`) base64-decodes it for the `.pkpass`
signer, and the APNs poke hands it to Node's `http2.connect({ key, ... })`.
`walletKeyFormat.test.ts` proves an unencrypted PEM loads and an encrypted one
does not, so this is checked rather than asserted.

Encrypting the key buys nothing here anyway: the passphrase would live in the
same Railway store as the key it protects.

## 4. Set the Railway env (API service)

```sh
WALLET_APPT_PASS_TYPE_ID=pass.com.getchairback.appointment
WALLET_APPT_PASS_CERT_BASE64=$(base64 -i wallet-appt-cert.pem)
WALLET_APPT_PASS_KEY_BASE64=$(base64 -i wallet-appt-key.pem)
```

**Three variables, and no passphrase** — with `-nodes` above the key is
unencrypted, so `WALLET_APPT_PASS_KEY_PASSPHRASE` must stay UNSET. Setting it
against an unencrypted key is not merely redundant; it is a second thing that
can drift out of step with the key.

(`WALLET_TEAM_ID` and `WALLET_WWDR_CERT_BASE64` are shared with the punch card
and must already be set. The appointment pass has its own Pass Type ID and its
own certificate — Apple binds each certificate to exactly one type id — so it
never reuses the punch card's cert or key.)

## 5. Verify

0. Confirm the three variables landed — **names only, never values**:

   ```sh
   railway variables --json | jq -r 'keys[] | select(startswith("WALLET_APPT_"))'
   ```

   `railway variables --json` returns a flat `{"NAME":"value"}` object (verified),
   so `keys[]` is the right expression. 🔴 Do NOT `grep` that output and do not
   use `--kv`: the CLI's own help says both print **raw values**, which for these
   variables is the certificate and the private key. If `jq` is not installed
   (it does not ship with macOS), the same thing with the Node already on the box:

   ```sh
   railway variables --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s)).filter(k=>k.startsWith('WALLET_APPT_')).sort().join('
')))"
   ```
1. Book a test appointment with your own email. The confirmation SCREEN should
   now show the Add-to-Wallet badge (iOS Safari, not the app), and the
   confirmation email should show BOTH "Add to Apple Wallet" and "Add to
   Calendar". Open `/r/<your magic token>` — the badge is under your next
   appointment there too.
2. Fetch the pass for real. 🔴 Not `curl -I`: that sends a **HEAD**, which can
   be answered without ever building or signing a pass — so it proves nothing
   about the thing you are trying to verify. Do a GET and inspect the bytes:

   ```sh
   # Paste the manage token when prompted. `read -rs` keeps it off the screen
   # AND out of shell history - never put a real token in a command line.
   read -rs MANAGE_TOKEN

   PASS_TMP="$(mktemp -t chairback-pass)"
   STATUS=$(curl -sS -o "$PASS_TMP" -D "$PASS_TMP.head" -w '%{http_code}'      "https://api.getchairback.com/api/book/manage/$MANAGE_TOKEN/wallet-pass")

   echo "status: $STATUS"                      # want 200 (404 = still dark)
   grep -i '^content-type:' "$PASS_TMP.head"   # want application/vnd.apple.pkpass
   file "$PASS_TMP"                            # want: Zip archive data
   unzip -l "$PASS_TMP" | grep -E 'pass\.json|manifest\.json|signature'

   rm -f "$PASS_TMP" "$PASS_TMP.head"
   unset MANAGE_TOKEN
   ```

   All four must hold: `200`, the pkpass content type, a real ZIP, and the three
   members inside it. A 200 that is not a ZIP means the route answered with JSON
   — read the status line rather than trusting the code.
3. Add the pass on an iPhone, then reschedule the appointment from the
   dashboard → within seconds the pass shows the new time (APNs poke).
4. Cancel it → the pass greys out as no longer valid.

Same expiry note as above: the cert renews yearly, refresh the two BASE64 vars.
