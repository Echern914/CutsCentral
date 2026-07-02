import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { NativeAuthError, signInWithProfile, type NativeProfile } from "./native.js";
import { sessionFromToken } from "./session.js";

/**
 * signInWithProfile: the find-or-link-or-create core of native (mobile)
 * Apple/Google sign-in. JWT verification needs real provider tokens, so these
 * tests exercise the account-resolution logic directly with pre-verified
 * profiles. Two invariants under test:
 *  1. An UNVERIFIED provider email can neither link into an existing account
 *     (takeover) nor create a new one (address squatting).
 *  2. The returned tokenVersion is the user's REAL version, so the session
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
  it("creates a new account for a verified provider email", async () => {
    const p = profile({ email: `native-create-${suffix}@test.local` });
    const { token, tokenVersion, user } = await signInWithProfile("google", p);
    expect(user.email).toBe(p.email);
    expect(tokenVersion).toBe(0);
    expect(sessionFromToken(token)?.userId).toBe(user.id);
  });

  it("refuses to create an account from an unverified email", async () => {
    const p = profile({
      email: `native-unverified-${suffix}@test.local`,
      emailVerified: false,
    });
    await expect(signInWithProfile("google", p)).rejects.toMatchObject({
      message: "email_unverified",
      status: 403,
    } satisfies Partial<NativeAuthError>);
  });

  it("links into an existing email account only when the email is verified", async () => {
    const email = `native-link-${suffix}@test.local`;
    createdEmails.push(email);
    const existing = await prisma.user.create({
      data: { email, name: "Existing Owner", passwordHash: "x" },
    });

    // Unverified: must NOT link (this is the account-takeover vector).
    const evil = profile({ email, emailVerified: false });
    await expect(signInWithProfile("apple", evil)).rejects.toMatchObject({
      message: "email_unverified",
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
    const p = profile({ email: `native-version-${suffix}@test.local` });
    const first = await signInWithProfile("google", p);
    // Simulate a logout (tokenVersion bump), then sign in again by provider id.
    await prisma.user.update({
      where: { id: first.user.id },
      data: { tokenVersion: 3 },
    });
    const again = await signInWithProfile("google", p);
    expect(again.user.id).toBe(first.user.id);
    expect(again.tokenVersion).toBe(3);
    expect(sessionFromToken(again.token)?.v).toBe(3);
  });

  it("signs in an already-linked user even if the email is unverified", async () => {
    const p = profile({ email: `native-relink-${suffix}@test.local` });
    const first = await signInWithProfile("apple", p);
    // Re-auth where Apple marks the email unverified/withholds trust: the
    // provider-id link (step 1) must still win.
    const reauth: NativeProfile = { ...p, emailVerified: false };
    const again = await signInWithProfile("apple", reauth);
    expect(again.user.id).toBe(first.user.id);
  });
});
