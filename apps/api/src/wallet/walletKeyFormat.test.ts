import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * THE PRIVATE-KEY FORMAT WALLET-SETUP.md TELLS YOU TO PRODUCE — proved loadable.
 *
 * The doc used to say the key passphrase was optional while handing you an
 * `openssl pkcs12 -nocerts` line that *always* prompts for one and always
 * writes an ENCRYPTED PEM. Follow it literally and you get a key the app cannot
 * load, with the failure surfacing at signing time — long after the deploy
 * looked healthy. The doc now commits to ONE path, and this file is the reason
 * that commitment is checkable rather than a claim:
 *
 *   `openssl pkcs12 -nocerts -nodes …`  ->  unencrypted PEM  ->  loads.
 *
 * 🔴 UNENCRYPTED IS WHAT PRODUCTION ALREADY RUNS. The live punch card has no
 * WALLET_PASS_KEY_PASSPHRASE set at all, so its key must be unencrypted — this
 * is the proven configuration, not a preference.
 *
 * The key is consumed in two places and both take this same PEM string:
 * `decodeWalletCerts` hands it to the .pkpass signer, and the APNs poke hands
 * it to Node's `http2.connect({ key, passphrase? })`. `createPrivateKey` here
 * is the same parser both of those end up in, so accepting/rejecting here is
 * the honest proxy for accepting/rejecting there.
 */
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from("wwdr-pem").toString("base64");

const { decodeWalletCerts } = await import("./pass.js");

const PASSPHRASE = "a-passphrase-the-env-would-have-to-carry";

/** One keypair, exported both ways — the only difference under test. */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const unencryptedPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const encryptedPem = privateKey.export({
  type: "pkcs8",
  format: "pem",
  cipher: "aes-256-cbc",
  passphrase: PASSPHRASE,
}) as string;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("the PEM the setup doc produces", () => {
  it("is recognisable on sight: the two headers differ", () => {
    // What to look for if a deploy ever goes wrong: `head -1 wallet-appt-key.pem`.
    expect(unencryptedPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(encryptedPem).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  });

  it("LOADS when produced with -nodes, carrying no passphrase", () => {
    // Exactly the documented path: unencrypted key, WALLET_APPT_PASS_KEY_PASSPHRASE unset.
    const certs = decodeWalletCerts({
      certBase64: b64("-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----"),
      keyBase64: b64(unencryptedPem),
    });
    expect(certs.signerKeyPassphrase).toBeUndefined();
    expect(() => createPrivateKey(certs.signerKey)).not.toThrow();
  });

  it("🔴 FAILS when -nodes is omitted and no passphrase is configured", () => {
    // The trap the doc used to walk you into. This is what "optional passphrase"
    // actually cost: a key that decodes to a perfectly valid-looking PEM string
    // and then refuses to parse.
    const certs = decodeWalletCerts({
      certBase64: b64("stub"),
      keyBase64: b64(encryptedPem),
    });
    expect(certs.signerKeyPassphrase).toBeUndefined();
    expect(() => createPrivateKey(certs.signerKey)).toThrow();
  });

  it("the encrypted key would work WITH its passphrase — the doc picks one, not both", () => {
    // Proof the alternative path is real, so choosing unencrypted is a decision
    // rather than a workaround for something broken.
    const certs = decodeWalletCerts({
      certBase64: b64("stub"),
      keyBase64: b64(encryptedPem),
      keyPassphrase: PASSPHRASE,
    });
    expect(certs.signerKeyPassphrase).toBe(PASSPHRASE);
    expect(() =>
      createPrivateKey({ key: certs.signerKey, passphrase: certs.signerKeyPassphrase }),
    ).not.toThrow();
  });

  it("decodes base64 to the PEM text verbatim — no re-encoding in the middle", () => {
    // `base64 -i wallet-appt-key.pem` on a Mac and Buffer.from(..., "base64")
    // here have to agree, or every one of the assertions above is vacuous.
    const certs = decodeWalletCerts({
      certBase64: b64("cert-text"),
      keyBase64: b64(unencryptedPem),
    });
    expect(certs.signerKey).toBe(unencryptedPem);
    expect(certs.signerCert).toBe("cert-text");
    expect(certs.wwdr).toBe("wwdr-pem");
  });
});
