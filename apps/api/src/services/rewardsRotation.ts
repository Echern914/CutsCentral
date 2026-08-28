import { forShop, prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { pokeWalletPass } from "../wallet/pass.js";

/**
 * magicToken rotation - the READ-side answer to the credential corpus.
 *
 * The write-side hygiene (messaging/auditBody.ts) stops NEW bearer URLs from
 * being stored, but months of Nudge history, message threads, screenshots and
 * forwarded texts already carry /r/<magicToken> links, and a magicToken never
 * expires. Rotation is the only operation that retires that corpus: mint a
 * fresh token, and every previously issued link for the client dies at once -
 * wherever it sits, including places no scrubber can reach.
 *
 * What a rotation breaks, and why that's now survivable:
 * - Old texted links land on the /r dead-link page, which offers the
 *   phone-recovery door (/my-rewards, #340 + #342). The verified phone is
 *   the identity; the link was always just the shortcut.
 * - The Apple Wallet pass QR embeds the rewards URL, so rotation POKES the
 *   pass: registered devices re-fetch and get the current token baked in.
 *   Un-poked or offline passes scan to the dead-link page - same door.
 * - A mobile app that adopted the old token cold-starts onto the dead-link
 *   page inside its WebView and recovers through the same door; builds with
 *   the native recovery flow (#340) re-adopt cleanly.
 *
 * NEVER rotate as a side effect. Both entry points are explicit human
 * decisions: a manager retiring one client's leaked link, or the platform
 * batch retiring the whole historical corpus.
 */

/** Rotate ONE client's link (manager action, shop-scoped). Archived clients
 * rotate too - an archived client's leaked link is still a live credential. */
export async function rotateClientMagicToken(
  shopId: string,
  clientId: string,
): Promise<"ok" | "not_found"> {
  const client = await forShop(shopId).client.findFirst({
    where: { id: clientId },
  });
  if (!client) return "not_found";
  await runAsOwner((tx) =>
    tx.client.update({
      where: { id: clientId },
      data: { magicToken: randomToken() },
    }),
  );
  // Refresh the Wallet pass QR - best-effort, never blocks the rotation.
  void pokeWalletPass(clientId).catch(() => {});
  logger.info({ shopId, clientId }, "rewards link rotated");
  return "ok";
}

/**
 * Rotate EVERY client's link, platform-wide - the one-time corpus retirement,
 * run AFTER the recovery doors are live. Batched keyset walk; each row gets
 * its own fresh token. Returns counts only.
 *
 * `opts` exists for the TESTS (a shop-scoped run against the shared test DB,
 * a tiny batch to exercise the keyset paging) - the admin route calls this
 * with no arguments, and that unscoped call is itself pinned by a test, so
 * a scope can never quietly creep into the production path.
 */
export async function rotateAllMagicTokens(
  opts: { scope?: { shopId: string }; batchSize?: number } = {},
): Promise<{ rotated: number; passesPoked: number }> {
  const batch = opts.batchSize ?? 500;
  const where = opts.scope ? { shopId: opts.scope.shopId } : {};
  let rotated = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{ id: string }> = await prisma.client.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    for (const row of page) {
      await prisma.client.update({
        where: { id: row.id },
        data: { magicToken: randomToken() },
      });
      rotated++;
    }
    cursor = page[page.length - 1]!.id;
    if (page.length < batch) break;
  }

  // Poke only clients that actually hold a Wallet pass - everyone else has
  // nothing to refresh.
  const regs = await prisma.walletPassRegistration.findMany({
    where: opts.scope ? { client: { shopId: opts.scope.shopId } } : {},
    select: { clientId: true },
    distinct: ["clientId"],
  });
  for (const r of regs) {
    await pokeWalletPass(r.clientId).catch(() => {});
  }
  logger.warn(
    { rotated, passesPoked: regs.length, scoped: Boolean(opts.scope) },
    "rewards links rotated in bulk",
  );
  return { rotated, passesPoked: regs.length };
}
