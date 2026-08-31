import { Router } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { runAsOwner } from "@chairback/db";
import {
  buildPassForClient,
  verifyPassAuth,
  walletEnabled,
} from "../wallet/pass.js";
import {
  appointmentWalletEnabled,
  buildPassForAppointment,
  verifyApptPassAuth,
} from "../wallet/appointmentPass.js";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Apple's PassKit Web Service protocol - the endpoints an iPhone calls to keep
 * a Wallet pass fresh. Both pass types embed webServiceURL =
 * `${API_BASE_URL}/api/wallet` and iOS appends the fixed /v1/... shapes below.
 *
 * TWO pass types share this one web service, split by the :passTypeIdentifier
 * iOS sends on every call:
 *   - the punch card (WALLET_PASS_TYPE_ID): serialNumber IS the client id
 *   - the appointment pass (WALLET_APPT_PASS_TYPE_ID): serialNumber IS the
 *     appointment id
 * Each type carries its own registration table, its own stateless HMAC auth
 * (domain-separated, so one type's token can never authenticate the other)
 * and its own builder. Everything below dispatches through ONE adapter per
 * request so the protocol logic never forks.
 *
 * Auth: register/unregister/fetch carry `Authorization: ApplePass <token>`,
 * the authenticationToken baked into the pass. The device-registrations LIST
 * endpoint has no auth header by protocol design: it only ever reveals serials
 * the device itself registered. Everything 404s while the named pass type is
 * unconfigured, and on any pass type id other than ours.
 */
export const walletRouter: Router = Router();

/** Everything one endpoint needs to serve ONE pass type. */
interface PassKindAdapter {
  kind: "rewards" | "appointment";
  verifyAuth(header: string | undefined, serial: string): boolean;
  /** Upsert a device registration; null = the serial does not exist. */
  register(
    deviceLibraryIdentifier: string,
    serial: string,
    pushToken: string,
  ): Promise<boolean | null>;
  unregister(deviceLibraryIdentifier: string, serial: string): Promise<void>;
  /**
   * The device's registered serials for this type, with each serial's
   * last-content-change instant (what makes `passesUpdatedSince` answerable).
   */
  listRegistrations(
    deviceLibraryIdentifier: string,
  ): Promise<Array<{ serial: string; changedAt: Date | null }>>;
  buildPass(serial: string): Promise<Buffer | null>;
}

const rewardsAdapter: PassKindAdapter = {
  kind: "rewards",
  verifyAuth: verifyPassAuth,
  register: (deviceLibraryIdentifier, serial, pushToken) =>
    runAsOwner(async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: serial },
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
          pushToken,
        },
        update: { pushToken },
      });
      return existing === null;
    }),
  unregister: (deviceLibraryIdentifier, serial) =>
    runAsOwner((tx) =>
      tx.walletPassRegistration.deleteMany({
        where: { deviceLibraryIdentifier, clientId: serial },
      }),
    ).then(() => undefined),
  // A punch card "changed" when its client has newer punch-ledger activity
  // (earn/redeem/bonus/reversal all write ledger rows, so the ledger's max
  // createdAt IS the pass freshness - no extra bookkeeping column).
  listRegistrations: (deviceLibraryIdentifier) =>
    runAsOwner(async (tx) => {
      const regs = await tx.walletPassRegistration.findMany({
        where: { deviceLibraryIdentifier },
        select: { clientId: true },
      });
      if (regs.length === 0) return [];
      const clientIds = regs.map((r) => r.clientId);
      const activity = await tx.punchLedger.groupBy({
        by: ["clientId"],
        where: { clientId: { in: clientIds } },
        _max: { createdAt: true },
      });
      const lastByClient = new Map(
        activity.map((a) => [a.clientId, a._max.createdAt ?? null]),
      );
      return clientIds.map((id) => ({
        serial: id,
        changedAt: lastByClient.get(id) ?? null,
      }));
    }),
  buildPass: buildPassForClient,
};

const appointmentAdapter: PassKindAdapter = {
  kind: "appointment",
  verifyAuth: verifyApptPassAuth,
  register: (deviceLibraryIdentifier, serial, pushToken) =>
    runAsOwner(async (tx) => {
      const appt = await tx.appointment.findUnique({
        where: { id: serial },
        select: { id: true, shopId: true },
      });
      if (!appt) return null;
      const existing = await tx.walletAppointmentPassRegistration.findUnique({
        where: {
          deviceLibraryIdentifier_appointmentId: {
            deviceLibraryIdentifier,
            appointmentId: appt.id,
          },
        },
      });
      await tx.walletAppointmentPassRegistration.upsert({
        where: {
          deviceLibraryIdentifier_appointmentId: {
            deviceLibraryIdentifier,
            appointmentId: appt.id,
          },
        },
        create: {
          shopId: appt.shopId,
          appointmentId: appt.id,
          deviceLibraryIdentifier,
          pushToken,
        },
        update: { pushToken },
      });
      return existing === null;
    }),
  unregister: (deviceLibraryIdentifier, serial) =>
    runAsOwner((tx) =>
      tx.walletAppointmentPassRegistration.deleteMany({
        where: { deviceLibraryIdentifier, appointmentId: serial },
      }),
    ).then(() => undefined),
  // An appointment pass "changed" when the appointment row itself did:
  // reschedule and cancellation both touch updatedAt (@updatedAt), which is
  // exactly the set of changes the pass face shows.
  listRegistrations: (deviceLibraryIdentifier) =>
    runAsOwner(async (tx) => {
      const regs = await tx.walletAppointmentPassRegistration.findMany({
        where: { deviceLibraryIdentifier },
        select: { appointment: { select: { id: true, updatedAt: true } } },
      });
      return regs
        .filter((r) => r.appointment)
        .map((r) => ({ serial: r.appointment.id, changedAt: r.appointment.updatedAt }));
    }),
  buildPass: buildPassForAppointment,
};

/**
 * Which pass type does this request address? null = not ours / that type is
 * dark, and the caller answers 404 - a probe learns nothing about which vars
 * are set. (If both env ids were ever misconfigured to the SAME value, the
 * punch card wins; the appointment vars exist to be different.)
 */
function adapterFor(passTypeIdentifier: string): PassKindAdapter | null {
  if (walletEnabled() && passTypeIdentifier === env.WALLET_PASS_TYPE_ID) {
    return rewardsAdapter;
  }
  if (
    appointmentWalletEnabled() &&
    passTypeIdentifier === env.WALLET_APPT_PASS_TYPE_ID
  ) {
    return appointmentAdapter;
  }
  return null;
}

const registerSchema = z.object({ pushToken: z.string().min(1).max(255) }).strict();

// Device registers for update pushes to one pass.
walletRouter.post(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
  async (req, res) => {
    const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
    const adapter = adapterFor(passTypeIdentifier);
    if (!adapter) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!adapter.verifyAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const created = await adapter.register(
      deviceLibraryIdentifier,
      serialNumber,
      parsed.data.pushToken,
    );
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
    const adapter = adapterFor(passTypeIdentifier);
    if (!adapter) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!adapter.verifyAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await adapter.unregister(deviceLibraryIdentifier, serialNumber);
    res.json({ ok: true });
  },
);

// Which of this device's passes (of one type) changed since the given tag?
// Tags are ISO instants; each adapter defines what "changed" means for its
// pass face.
walletRouter.get(
  "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier",
  async (req, res) => {
    const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
    const adapter = adapterFor(passTypeIdentifier);
    if (!adapter) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const sinceRaw = req.query.passesUpdatedSince;
    const since =
      typeof sinceRaw === "string" && !Number.isNaN(Date.parse(sinceRaw))
        ? new Date(sinceRaw)
        : null;

    const rows = await adapter.listRegistrations(deviceLibraryIdentifier);
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const serials = rows
      .filter((r) => {
        if (!since) return true; // first sync: everything
        return r.changedAt != null && r.changedAt.getTime() > since.getTime();
      })
      .map((r) => r.serial);
    const newest = rows.reduce<Date | null>(
      (acc, r) => (r.changedAt && (!acc || r.changedAt > acc) ? r.changedAt : acc),
      null,
    );

    if (serials.length === 0) {
      res.status(204).end();
      return;
    }
    res.json({
      lastUpdated: (newest ?? new Date()).toISOString(),
      serialNumbers: serials,
    });
  },
);

// The device fetches the latest pass after a poke (or on manual refresh).
walletRouter.get(
  "/v1/passes/:passTypeIdentifier/:serialNumber",
  async (req, res) => {
    const { passTypeIdentifier, serialNumber } = req.params;
    const adapter = adapterFor(passTypeIdentifier);
    if (!adapter) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!adapter.verifyAuth(req.header("Authorization"), serialNumber)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const pass = await adapter.buildPass(serialNumber);
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
