import "../src/env-bootstrap.js";
import { prisma } from "@chairback/db";
import { billingEnabled, stripeClient } from "../src/billing/stripe.js";

/**
 * Move a user's login email by hand, for the case the self-serve flow cannot
 * reach: the barber no longer receives mail at the address they signed up with,
 * so the verification link sent to the NEW address is the only proof of control
 * they have - and they never see it, because POST /change-email answers a
 * constant "check your inbox" whether or not it actually sent anything
 * (deliberate: that endpoint must not become an address-enumeration oracle).
 * From the outside, "the address is already someone's login" and "the mail is in
 * spam" look identical. This script tells the operator which one it is.
 *
 * It reproduces exactly what redeeming a verification token does in
 * routes/emailChange.ts - the new address, the session revocation, the Stripe
 * customer sync - so a support fix and a self-serve change leave the account in
 * the same state. Hand-written SQL gets the first, usually the second, and never
 * the third, which is how receipts and dunning keep going to an address nobody
 * reads.
 *
 * Usage (from the repo root, with DATABASE_URL pointed at the target DB):
 *   pnpm --filter @chairback/api admin:email <currentEmail> --check
 *   pnpm --filter @chairback/api admin:email <currentEmail> <newEmail>
 *   pnpm --filter @chairback/api admin:email <currentEmail> <newEmail> --keep-sessions
 *
 * --check resolves and reports, writing nothing. Run it first.
 *
 * --keep-sessions skips the tokenVersion bump. The self-serve flow always bumps
 * it, because there a change could BE the attack and the real owner's sessions
 * dying loudly is the alarm. Here the operator already knows who asked, and the
 * cost lands on the barber: signed out of every device, and back in only via the
 * NEW address. Safe when they have Google/Apple sign-in (keyed by provider sub,
 * not email, so none of this touches them) or know their password - the report
 * prints which of those they have, so decide after reading it, not before.
 */

/**
 * Which database is about to be written to, host and name only - never the
 * credentials in between. Printed before anything else because the repo-root
 * .env supplies a DATABASE_URL of its own: an exported one wins (dotenv does
 * not override), but FORGETTING to export is silent, and the difference between
 * "no user with that email" in dev and in prod is invisible without this line.
 */
function dbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(DATABASE_URL unset)";
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

type Ways = { password: boolean; google: boolean; apple: boolean };

function waysIn(w: Ways): string {
  const ways = [
    w.password ? "password" : null,
    w.google ? "Google" : null,
    w.apple ? "Apple" : null,
  ].filter(Boolean);
  return ways.length > 0 ? ways.join(" + ") : "NONE - they cannot sign in at all today";
}

/**
 * findFirst + insensitive rather than findUnique: addresses are lowercased at
 * every write path today, but a row predating that would be invisible to an
 * exact lookup and the operator would be told "no such user" about a user
 * sitting right there in the dashboard.
 */
async function describe(email: string) {
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      createdAt: true,
      passwordHash: true,
      googleId: true,
      appleId: true,
      shops: { select: { id: true, name: true, slug: true, stripeCustomerId: true } },
      shopMemberships: {
        select: { role: true, shop: { select: { name: true, slug: true } } },
      },
    },
  });
}

type Described = NonNullable<Awaited<ReturnType<typeof describe>>>;

function report(user: Described, log: (line: string) => void): void {
  log(`${user.email}  (${user.name})`);
  log(`  id ${user.id}, created ${user.createdAt.toISOString().slice(0, 10)}`);
  log(`  platform admin: ${user.isAdmin ? "YES" : "no"}`);
  log(
    `  can sign in with: ${waysIn({
      password: Boolean(user.passwordHash),
      google: Boolean(user.googleId),
      apple: Boolean(user.appleId),
    })}`,
  );
  for (const s of user.shops) {
    log(`  owns: ${s.name} (${s.slug})${s.stripeCustomerId ? "  [billed at Stripe]" : ""}`);
  }
  for (const m of user.shopMemberships) {
    log(`  member of: ${m.shop.name} (${m.shop.slug}) as ${m.role}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const currentEmail = positional[0]?.trim().toLowerCase();
  const newEmail = positional[1]?.trim().toLowerCase();
  const checkOnly = flags.has("--check");
  const keepSessions = flags.has("--keep-sessions");

  if (!currentEmail || (!newEmail && !checkOnly)) {
    console.error("Usage: admin:email <currentEmail> <newEmail> [--keep-sessions]");
    console.error("       admin:email <currentEmail> --check");
    process.exit(1);
  }

  console.log(`Database:  ${dbTarget()}\n`);

  const user = await describe(currentEmail);
  if (!user) {
    console.error(`No user with email ${currentEmail} in ${dbTarget()}.`);
    console.error("If that is not the database you meant, export DATABASE_URL and re-run.");
    process.exit(1);
  }
  console.log("Account:");
  report(user, (l) => console.log(l));

  if (!newEmail) {
    await prisma.$disconnect();
    return;
  }
  if (newEmail === user.email.toLowerCase()) {
    console.error(`\n${newEmail} is already this account's email. Nothing to do.`);
    process.exit(1);
  }

  // THE usual reason no verification email ever arrives. Naming the holder is
  // right here and wrong in the HTTP route: this runs as the platform operator
  // against their own database, not on behalf of an anonymous caller.
  const taken = await describe(newEmail);
  if (taken) {
    console.error(`\n${newEmail} is ALREADY a ChairBack login.`);
    console.error("That is why no verification email ever arrived - the flow sends nothing");
    console.error("to an address that is already taken, and still says \"check your inbox\".\n");
    report(taken, (l) => console.error(l));
    console.error(
      taken.shops.length === 0 && taken.shopMemberships.length === 0
        ? "\nThat account owns nothing and belongs to no shop - most likely a duplicate\nsignup. Decide what happens to it before re-running; this script never deletes\nan account."
        : "\nThat account has real data behind it. Merging two accounts is NOT something\nthis script does.",
    );
    process.exit(1);
  }

  if (checkOnly) {
    console.log(`\n${newEmail} is free. Re-run without --check to move the address.`);
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        email: newEmail,
        // Same reason the route bumps it: every token minted under the old
        // identity stops working. Skippable here (see the header) because the
        // operator, not an unknown caller, is the one asking.
        ...(keepSessions ? {} : { tokenVersion: { increment: 1 } }),
      },
    }),
    // Any half-finished self-serve attempt still points at the old identity and
    // would apply a stale address if it were redeemed later.
    prisma.emailChangeToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
  ]);

  console.log(`\nMoved ${user.email} -> ${newEmail}.`);
  console.log(
    keepSessions
      ? "Sessions kept: they stay signed in, and use the NEW address next time they sign in."
      : "Sessions revoked: they must sign in again, with the NEW address.",
  );

  // Best-effort, exactly like the route: the address has already moved, and a
  // Stripe hiccup must not make it look like it did not.
  if (!billingEnabled()) {
    console.log("Billing is not configured here - skipped the Stripe customer sync.");
    await prisma.$disconnect();
    return;
  }
  const billed = user.shops.filter((s) => s.stripeCustomerId);
  if (billed.length === 0) {
    console.log("No billed shops - nothing to sync at Stripe.");
  }
  for (const shop of billed) {
    try {
      await stripeClient().customers.update(shop.stripeCustomerId as string, {
        email: newEmail,
      });
      console.log(`Stripe customer for ${shop.name} updated.`);
    } catch (err) {
      console.error(
        `Stripe customer for ${shop.name} (${shop.stripeCustomerId}) NOT updated:`,
        err instanceof Error ? err.message : err,
      );
      console.error("  Fix it in the Stripe dashboard, or receipts keep going to the old address.");
    }
  }

  await prisma.$disconnect();
}

void main();
