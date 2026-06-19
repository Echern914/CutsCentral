import { forShop } from "@chairback/db";
import { toE164 } from "../acuity/clientKey.js";

/**
 * Barber edits to a client's own profile. The barber is admin over their book:
 * they can fix a misspelled name, correct a phone/email, and soft-archive (hide)
 * or restore a client.
 *
 * Two deliberate non-actions:
 *  - Editing phone/email does NOT rewrite acuityClientKey. That key is the SYNC
 *    identity (how Acuity re-finds this row on the next booking, the idempotent
 *    upsert anchor) - repointing it on a display-field correction would risk a
 *    future booking forking into a duplicate or colliding with another row. The
 *    add-client upsert's update path already leaves the key alone for the same
 *    reason; we keep phone/email as the contact fields and the key as the anchor.
 *  - Editing does NOT touch SMS consent. Consent has its own attestation path
 *    (bulk attestConsent / the join page); a profile edit must never fabricate or
 *    clear it. Correcting a phone keeps the prior consent record intact.
 */

export interface EditClientInput {
  firstName?: string;
  /** "" clears the last name; undefined leaves it unchanged. */
  lastName?: string | null;
  /** "" clears; a non-empty value must parse to E.164 or the edit is refused. */
  phone?: string | null;
  /** "" clears; undefined leaves unchanged. */
  email?: string | null;
}

export type EditClientResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_phone" };

/**
 * Update a client's name / phone / email. A supplied-but-unparseable phone is
 * refused (same rule as add-client): silently storing null would make the barber
 * think the client is reachable when they never will be. An explicit empty string
 * clears the field.
 */
export async function editClient(
  shopId: string,
  clientId: string,
  input: EditClientInput,
): Promise<EditClientResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };

  const data: Record<string, unknown> = {};

  if (input.firstName !== undefined) data.firstName = input.firstName;

  if (input.lastName !== undefined) {
    data.lastName = input.lastName ? input.lastName : null;
  }

  if (input.phone !== undefined) {
    const raw = (input.phone ?? "").trim();
    if (raw === "") {
      data.phone = null;
    } else {
      const e164 = toE164(raw);
      if (!e164) return { ok: false, reason: "invalid_phone" };
      data.phone = e164;
    }
  }

  if (input.email !== undefined) {
    const e = (input.email ?? "").trim().toLowerCase();
    data.email = e === "" ? null : e;
  }

  // Nothing to change (all fields omitted) - treat as a no-op success.
  if (Object.keys(data).length === 0) return { ok: true };

  await db.client.update({ where: { id: client.id }, data });
  return { ok: true };
}

export type ArchiveResult =
  | { ok: true; archived: boolean }
  | { ok: false; reason: "not_found" };

/**
 * Soft-archive a client: stamp archivedAt so it drops out of every active surface
 * (clients list default, stats, leaderboard, at-risk, all SMS sends) without
 * destroying any visits / ledger / nudge history. Idempotent: archiving an
 * already-archived client keeps the original archivedAt.
 */
export async function archiveClient(
  shopId: string,
  clientId: string,
): Promise<ArchiveResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };
  if (client.archivedAt === null) {
    await db.client.update({
      where: { id: client.id },
      data: { archivedAt: new Date() },
    });
  }
  return { ok: true, archived: true };
}

/** Restore an archived client back into the active book (clears archivedAt). */
export async function unarchiveClient(
  shopId: string,
  clientId: string,
): Promise<ArchiveResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };
  if (client.archivedAt !== null) {
    await db.client.update({
      where: { id: client.id },
      data: { archivedAt: null },
    });
  }
  return { ok: true, archived: false };
}
