import { runAsOwner, type Prisma } from "@chairback/db";

/**
 * A barber's or manager's phone, registered for their booking alerts - and
 * dropped again when they sign out.
 *
 * 🔴 THE ORDERING THIS EXISTS FOR. Sign-out bumps `User.tokenVersion` (every
 * session dies) and deletes the user's devices. A registration that passed
 * `requireUser` a moment BEFORE the bump, and wrote a moment AFTER the delete,
 * would put the phone straight back: the next person to pick it up would get
 * the signed-out barber's alerts, client names and all.
 *
 * Both writes therefore take the user's row lock first. Sign-out's UPDATE of
 * tokenVersion holds it until its delete commits; a registration re-reads the
 * version under `FOR UPDATE` and writes only if it still matches the session it
 * arrived with. Whichever goes first, the other sees its result: a sign-out
 * that wins makes the registration refuse, and a registration that wins is
 * deleted by the sign-out that follows.
 */

/** Sign-out: kill every session and every registered device, atomically. */
export async function signOutEverywhere(userId: string): Promise<void> {
  await runAsOwner(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    await tx.pushSubscription.deleteMany({ where: { userId } });
  });
}

/**
 * Register (or re-point) this device for the user's alerts. False when the
 * session it came with has been revoked in the meantime - nothing is written.
 *
 * Upsert by token: the same phone signing in as someone else moves the row to
 * them, so one device is only ever one person's.
 */
export async function registerUserDevice(args: {
  userId: string;
  sessionVersion: number;
  shopId: string;
  expoPushToken: string;
  platform: string | null;
}): Promise<boolean> {
  return runAsOwner(async (tx) => {
    if (!(await sessionStillLive(tx, args.userId, args.sessionVersion))) return false;
    await tx.pushSubscription.upsert({
      where: { expoPushToken: args.expoPushToken },
      create: {
        shopId: args.shopId,
        userId: args.userId,
        kind: "expo",
        expoPushToken: args.expoPushToken,
        userAgent: args.platform,
      },
      update: {
        shopId: args.shopId,
        userId: args.userId,
        // A device is one identity: if this token ever re-registers from the
        // barber app after being a customer device, it stops being client-keyed.
        clientId: null,
        kind: "expo",
        userAgent: args.platform,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
    });
    return true;
  });
}

async function sessionStillLive(tx: Prisma.TransactionClient, userId: string, version: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ tokenVersion: number }[]>`
    SELECT "tokenVersion" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows[0]?.tokenVersion === version;
}
