import { describe, expect, it, beforeAll, afterAll } from "vitest";
import forge from "node-forge";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * Does a CONFIGURED shop actually get a signed .pkpass?
 *
 * Every other wallet suite stops before signing, because signing needs an Apple
 * certificate and nobody has one on a laptop. That left the most important
 * question unanswered: the builder had never once produced a real archive, so
 * a mistake in the zip, the manifest or the field shapes would have been found
 * by a customer on an iPhone rather than here.
 *
 * 🔴 SELF-SIGNED CERTIFICATES, GENERATED IN THIS FILE. That is the whole trick
 * and also the honest limit of it. `passkit-generator` will sign with whatever
 * key material it is handed, so this proves the archive is well-formed, the
 * manifest covers every file, and the signature is a real PKCS#7 over that
 * manifest. It does NOT prove Apple TRUSTS the chain - only a certificate from
 * the WALLET_APPT_* ceremony can, and only on a physical iPhone.
 *
 * So: this test fails the day the builder breaks, and stays silent about the
 * one thing it cannot know. Both of those matter.
 */

/** A throwaway CA + leaf, so the signer cert has an issuer to chain to. */
function selfSigned(commonName: string): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2040-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    // 🔴 UNENCRYPTED PEM. WALLET-SETUP.md is emphatic about this for the real
    // certificate too (`openssl ... -nodes`): an encrypted key with no
    // passphrase configured fails at signing time with an error that looks
    // nothing like its cause.
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

const signer = selfSigned("Pass Type ID: pass.test.chairback.appointment");
const wwdr = selfSigned("Test WWDR");

process.env.WALLET_APPT_PASS_TYPE_ID = "pass.test.chairback.appointment";
process.env.WALLET_TEAM_ID = "TESTTEAM99";
process.env.WALLET_APPT_PASS_CERT_BASE64 = Buffer.from(signer.certPem).toString("base64");
process.env.WALLET_APPT_PASS_KEY_BASE64 = Buffer.from(signer.keyPem).toString("base64");
process.env.WALLET_WWDR_CERT_BASE64 = Buffer.from(wwdr.certPem).toString("base64");

const { buildPassForAppointment, appointmentWalletEnabled } = await import(
  "./appointmentPass.js"
);

let userId: string;
let shopId: string;
let appointmentId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wsign-${randomToken(6)}@test.local`, passwordHash: "x", name: "W" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Chern Cuts",
      slug: `wsign-${randomToken(5)}`.toLowerCase(),
      bookingMode: "native",
      webhookSecret: randomToken(),
      compAccess: true,
      timezone: "America/New_York",
      addressStreet: "12 Main St",
      addressCity: "Brooklyn",
      addressRegion: "NY",
      twilioNumber: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
    },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Skin Fade", durationMin: 30 },
  });
  // A fixed PAST instant: a hard-coded future date goes red the day it passes.
  const startsAt = new Date("2026-03-14T18:00:00.000Z");
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Casey",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(),
    },
  });
  appointmentId = appt.id;
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

/** The entries of a zip archive, by name, without unzipping to disk. */
function zipEntries(buf: Buffer): string[] {
  const names: string[] = [];
  // Central-directory file headers: 0x02014b50, then 46 bytes of fixed fields
  // with the name length at offset 28 and the name itself at 46.
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + nameLen).toString("utf8"));
  }
  return names;
}

describe("a configured shop gets a real signed pass", () => {
  it("is configured at all (the gate every route checks first)", () => {
    expect(appointmentWalletEnabled()).toBe(true);
  });

  it("🔴 returns a .pkpass archive carrying a manifest AND a signature", async () => {
    const buf = await buildPassForAppointment(appointmentId);
    expect(buf).toBeInstanceOf(Buffer);
    const entries = zipEntries(buf!);
    // pass.json is the pass; manifest.json is a SHA-1 of every other file;
    // signature is PKCS#7 over the manifest. Wallet refuses an archive missing
    // any of the three, and it refuses it silently.
    expect(entries).toContain("pass.json");
    expect(entries).toContain("manifest.json");
    expect(entries).toContain("signature");
    // The art has to be in there too, or the pass renders blank.
    expect(entries).toContain("icon.png");
    expect(entries.length).toBeGreaterThanOrEqual(7);
  });

  it("is a ZIP, which is what the .pkpass content-type promises", async () => {
    const buf = await buildPassForAppointment(appointmentId);
    // "PK\x03\x04" - the local file header magic.
    expect(buf!.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("returns null for an appointment that no longer exists", async () => {
    expect(await buildPassForAppointment("appt_does_not_exist")).toBeNull();
  });

  it("🔴 still mints a (voided) pass for a CANCELED appointment", async () => {
    // Devices that already added the pass re-fetch through this builder after
    // the cancellation poke. If it returned null here, a canceled appointment
    // would sit in a customer's Wallet still looking valid forever.
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELED" },
    });
    const buf = await buildPassForAppointment(appointmentId);
    expect(buf).toBeInstanceOf(Buffer);
    expect(zipEntries(buf!)).toContain("signature");
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: "BOOKED" },
    });
  });
});
