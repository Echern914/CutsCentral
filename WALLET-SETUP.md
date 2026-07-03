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
