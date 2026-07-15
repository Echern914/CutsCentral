import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { NativeAuthError, signInWithProfile, type NativeProfile } from "./native.js";
import { sessionFromToken } from "./session.js";

/**
 * signInWithProfile: the find-or-link core of native (mobile) Apple/Google
 * sign-in. JWT verification needs real provider tokens, so these tests exercise
 * the account-resolution logic directly with pre-verified profiles. Three
 * invariants under test:
 *  1. LOGIN-ONLY: a profile matching no existing account is refused with
 *     account_not_found, never created (App Store Guideline 3.1.1 - business
 *     sign-up must not exist in the app; it lives on the web).
 *  2. An UNVERIFIED provider email can never link into an existing account
 *     (takeover), and the refusal is indistinguishable from "no account"
 *     (no email-enumeration oracle).
 *  3. The returned tokenVersion is the user's REAL version, so the session
 *     cookie set from it stays valid for users who have logged out or changed
 *     their password before (tokenVersion > 0).
 */

const suffix = randomToken(6).toLowerCase();
const createdEmails: string[] = [];

function profile(overrides: Partial<NativeProfile> & { email: string }): NativeProfile {
  createdEmails.push(overrides.email);
  return {
    sub: `sub-${randomToken(8)}`,
    name: "Native Tester",
    emailVerified: true,
    ...overrides,
  };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

describe("signInWithProfile", () => {
  it("refuses to create an account for an unknown profile (login-only)", async () => {
    const p = profile({ email: `native-create-${suffix}@test.local` });
    await expect(signInWithProfile("google", p)).rejects.toMatchObject({
      message: "account_not_found",
      status: 403,
    } satisfies Partial<NativeAuthError>);
    const created = await prisma.user.findUnique({ where: { email: p.email! } });
    expect(created).toBeNull();
  });

  it("refuses an unverified unknown email with the same account_not_found", async () => {
    const p = profile({
      email: `native-unverified-${suffix}@test.local`,
      emailVerified: false,
    });
    await expect(signInWithProfile("google", p)).rejects.toMatchObject({
      message: "account_not_found",
      status: 403,
    } satisfies Partial<NativeAuthError>);
  });

  it("links into an existing email account only when the email is verified", async () => {
    const email = `native-link-${suffix}@test.local`;
    createdEmails.push(email);
    const existing = await prisma.user.create({
      data: { email, name: "Existing Owner", passwordHash: "x" },
    });

    // Unverified: must NOT link (this is the account-takeover vector), and the
    // error must not reveal that the email exists.
    const evil = profile({ email, emailVerified: false });
    await expect(signInWithProfile("apple", evil)).rejects.toMatchObject({
      message: "account_not_found",
    });
    const untouched = await prisma.user.findUnique({ where: { id: existing.id } });
    expect(untouched?.appleId).toBeNull();

    // Verified: links.
    const good = profile({ email });
    const { user } = await signInWithProfile("apple", good);
    expect(user.id).toBe(existing.id);
    const linked = await prisma.user.findUnique({ where: { id: existing.id } });
    expect(linked?.appleId).toBe(good.sub);
  });

  it("returns the user's real tokenVersion so the minted session is valid", async () => {
    const email = `native-version-${suffix}@test.local`;
    createdEmails.push(email);
    await prisma.user.create({
      data: { email, name: "Version Owner", passwordHash: "x", tokenVersion: 3 },
    });
    const p = profile({ email });
    const { token, tokenVersion, user } = await signInWithProfile("google", p);
    expect(tokenVersion).toBe(3);
    expect(sessionFromToken(token)?.userId).toBe(user.id);
    expect(sessionFromToken(token)?.v).toBe(3);
  });

  it("signs in an already-linked user even if the email is unverified", async () => {
    const email = `native-relink-${suffix}@test.local`;
    createdEmails.push(email);
    const sub = `sub-${randomToken(8)}`;
    const existing = await prisma.user.create({
      data: { email, name: "Linked Owner", appleId: sub },
    });
    // Re-auth where Apple marks the email unverified/withholds trust: the
    // provider-id link (step 1) must still win.
    const reauth: NativeProfile = {
      sub,
      email,
      name: "Linked Owner",
      emailVerified: false,
    };
    const again = await signInWithProfile("apple", reauth);
    expect(again.user.id).toBe(existing.id);
  });
});
