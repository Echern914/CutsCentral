import { Router } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import {
  buildPassForClient,
  verifyPassAuth,
  walletEnabled,
} from "../wallet/pass.js";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Apple's PassKit Web Service protocol - the endpoints an iPhone calls to keep
 * a Wallet pass fresh. The pass embeds webServiceURL = `${API_BASE_URL}/api/wallet`
 * and iOS appends the fixed /v1/... shapes below. serialNumber IS the client id.
 *
 * Auth: register/unregister/fetch carry `Authorization: ApplePass <token>`,
 * the authenticationToken baked into the pass (a stateless HMAC of the client
 * id - see wallet/pass.ts). The device-registrations LIST endpoint has no auth
 * header by protocol design: it only ever reveals serials the device itself
 * registered. Everything 404s while wallet is unconfigured, and on any pass
 * type id other than ours.
 */
export const walletRouter: Router = Router();

/** Shared gate: wallet configured + the pass type in the URL is ours. */
function gated(passTypeIdentifier: string): boolean {
  return walletEnabled() && passTypeIdentifier === env.WALLET_PASS_TYPE_ID;
}

const registerSchema = z.object({ pushToken: z.string().min(1).max(255) }).strict();

// Device registers for update pushes to one pass.
walletRouter.post(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
  async (req, res) => {
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    if (!gated(passTypeIdentifier)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!verifyPassAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const created = await runAsOwner(async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: serialNumber },
        select: { id: true, shopId: true },
      });
      if (!client) return null;
      const existing = await tx.walletPassRegistration.findUnique({
        where: {
          deviceLibraryIdentifier_clientId: {
            deviceLibraryIdentifier,
            clientId: client.id,
          },
        },
      });
      await tx.walletPassRegistration.upsert({
        where: {
          deviceLibraryIdentifier_clientId: {
            deviceLibraryIdentifier,
            clientId: client.id,
          },
        },
        create: {
          shopId: client.shopId,
          clientId: client.id,
          deviceLibraryIdentifier,
          pushToken: parsed.data.pushToken,
        },
        update: { pushToken: parsed.data.pushToken },
      });
      return existing === null;
    });

    if (created === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Protocol: 201 = newly registered, 200 = this device already had it.
    res.status(created ? 201 : 200).json({ ok: true });
  },
);

// Device unregisters (pass removed from Wallet).
walletRouter.delete(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
  async (req, res) => {
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    if (!gated(passTypeIdentifier)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!verifyPassAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await runAsOwner((tx) =>
      tx.walletPassRegistration.deleteMany({
        where: { deviceLibraryIdentifier, clientId: serialNumber },
      }),
    );
    res.json({ ok: true });
  },
);

// Which of this device's passes changed since the given tag? Tags are ISO
// instants; a pass "changed" when its client has newer punch-ledger activity
// (earn/redeem/bonus/reversal all write ledger rows, so the ledger's max
// createdAt IS the pass freshness - no extra bookkeeping column).
walletRouter.get(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier",
  async (req, res) => {
    const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
    if (!gated(passTypeIdentifier)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const sinceRaw = req.query.passesUpdatedSince;
    const since =
      typeof sinceRaw === "string" && !Number.isNaN(Date.parse(sinceRaw))
        ? new Date(sinceRaw)
        : null;

    const result = await runAsOwner(async (tx) => {
      const regs = await tx.walletPassRegistration.findMany({
        where: { deviceLibraryIdentifier },
        select: { clientId: true },
      });
      if (regs.length === 0) return null;
      const clientIds = regs.map((r) => r.clientId);
      const activity = await tx.punchLedger.groupBy({
        by: ["clientId"],
        where: { clientId: { in: clientIds } },
        _max: { createdAt: true },
      });
      const lastByClient = new Map(
        activity.map((a) => [a.clientId, a._max.createdAt ?? null]),
      );
      const serials = clientIds.filter((id) => {
        if (!since) return true; // first sync: everything
        const last = lastByClient.get(id);
        return last != null && last.getTime() > since.getTime();
      });
      const newest = [...lastByClient.values()].reduce<Date | null>(
        (acc, d) => (d && (!acc || d > acc) ? d : acc),
        null,
      );
      return { serials, lastUpdated: (newest ?? new Date()).toISOString() };
    });

    if (!result) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (result.serials.length === 0) {
      res.status(204).end();
      return;
    }
    res.json({ lastUpdated: result.lastUpdated, serialNumbers: result.serials });
  },
);

// The device fetches the latest pass after a poke (or on manual refresh).
walletRouter.get(
  "/v1/passes/:passTypeIdentifier/:serialNumber",
  async (req, res) => {
    const { passTypeIdentifier, serialNumber } = req.params;
    if (!gated(passTypeIdentifier)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!verifyPassAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const pass = await buildPassForClient(serialNumber);
    if (!pass) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res
      .set("Content-Type", "application/vnd.apple.pkpass")
      .set("Last-Modified", new Date().toUTCString())
      .send(pass);
  },
);

// Device-side error reports (invaluable when a pass misbehaves in the field).
// This endpoint is UNauthenticated per Apple's PassKit spec (the log callback
// carries no token), so the body is attacker-controllable. Log at `info` (not
// `warn`, which typically drives alerting) and hard-cap what we keep so a
// flood of junk can't pollute logs or inflate volume: at most 20 entries, each
// coerced to a string and truncated.
walletRouter.post("/v1/log", (req, res) => {
  const logs = (req.body as { logs?: unknown })?.logs;
  if (Array.isArray(logs) && logs.length > 0) {
    const capped = logs
      .slice(0, 20)
      .map((l) => String(l).slice(0, 500));
    logger.info({ logs: capped }, "wallet pass device log");
  }
  res.json({ ok: true });
});
