import { Router } from "express";
import { prisma } from "@chairback/db";
import { SCOPE_LABELS } from "@chairback/config/mcpScopes";
import { requireShop, requireUser } from "../middleware/auth.js";
import { dashboardLimiter } from "../middleware/rateLimit.js";
import { logMcpAuth } from "../mcp/audit.js";
import { hasMcpEntitlement, MCP_REQUIRED_PLAN_LABEL } from "../mcp/entitlement.js";
import { mcpResourceUrl } from "../mcp/metadata.js";
import { revokeConnection } from "../mcp/tokens.js";

/**
 * The barber's own view of which assistants can read their shop, and the button
 * that cuts one off.
 *
 * ── 🔴 WHY DISCONNECT MUST BE INSTANT ────────────────────────────────────────
 *
 * This is the control a human reaches for when something is wrong - a laptop
 * lost, an assistant behaving oddly, an employee gone. "Revoked, but it keeps
 * working for up to fifteen minutes" is not a disconnect button, it is a
 * promise to disconnect. So this calls the same `revokeConnection` the replay
 * and membership paths use, which kills the connection row AND every access and
 * refresh token hanging off it in one transaction. The next request fails at
 * `resolveAccessToken`, not at expiry.
 *
 * ── WHO SEES WHAT ────────────────────────────────────────────────────────────
 *
 * A connection belongs to a (user, shop, client) triple, so a barber sees their
 * own. An OWNER or MANAGER additionally sees every connection into their shop
 * and can revoke any of them - not for surveillance, but because "an employee
 * connected an assistant and left" has to be fixable by the person accountable
 * for the shop's data. Losing a seat already kills a connection on the next
 * request; this is the same power, exercised deliberately.
 *
 * NEVER WALLED, and never plan-gated. A shop that has lapsed or downgraded must
 * still be able to SEE and REVOKE whatever it connected while it was paying -
 * hiding the list would leave live grants a barber cannot reach.
 */
export const mcpConnectionsRouter: Router = Router();
mcpConnectionsRouter.use(requireUser, requireShop, dashboardLimiter);

/** What the dashboard renders. No token material of any kind. */
function wire(c: {
  id: string;
  userId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  accessLevel: string;
  client: { clientName: string } | null;
  user: { name: string | null } | null;
  grants: { scope: string }[];
}, viewerId: string) {
  return {
    id: c.id,
    // The client's self-declared name from RFC 7591 registration. Shop-visible
    // and shop-controlled by nobody - it comes from the AI client.
    clientName: c.client?.clientName ?? "Unknown assistant",
    connectedAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    accessLevel: c.accessLevel,
    /** Whose connection this is, in the viewer's terms. */
    mine: c.userId === viewerId,
    connectedBy: c.userId === viewerId ? "You" : (c.user?.name ?? "A team member"),
    // Human-facing scope copy, the same words the consent screen used.
    permissions: c.grants.map((g) => SCOPE_LABELS[g.scope] ?? g.scope),
  };
}

/**
 * GET /api/mcp/connections
 *
 * The list, plus everything the panel needs to render its own state: whether
 * this shop's plan includes the connector, and the URL to paste into the AI
 * client if it does.
 */
mcpConnectionsRouter.get("/connections", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const isManager = req.shopRole === "OWNER" || req.shopRole === "MANAGER";

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { plan: true, subscriptionStatus: true, trialEndsAt: true, compAccess: true },
  });
  const entitled = shop ? hasMcpEntitlement(shop) : false;

  const connections = await prisma.mcpConnection.findMany({
    where: {
      shopId,
      revokedAt: null,
      // A barber sees their own; a manager sees the shop's.
      ...(isManager ? {} : { userId }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      lastUsedAt: true,
      accessLevel: true,
      client: { select: { clientName: true } },
      user: { select: { name: true } },
      grants: { where: { revokedAt: null }, select: { scope: true } },
    },
  });

  res.json({
    entitled,
    requiredPlan: MCP_REQUIRED_PLAN_LABEL,
    /**
     * 🔴 The URL a human pastes into their AI client, derived from config -
     * never from the request Host. It is also the `resource` every token is
     * bound to, so what is shown here and what is enforced cannot drift.
     */
    connectUrl: entitled ? mcpResourceUrl() : null,
    // Read-only is the only level this release can mint. Stated so the panel
    // can say so without hardcoding it.
    accessLevel: "READ_ONLY",
    connections: connections.map((c) => wire(c, userId)),
  });
});

/**
 * DELETE /api/mcp/connections/:id
 *
 * 🔴 IMMEDIATE. Not "marked for revocation" - the connection and every token on
 * it die in one transaction, so the very next request from that assistant is
 * refused.
 */
mcpConnectionsRouter.delete("/connections/:id", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const isManager = req.shopRole === "OWNER" || req.shopRole === "MANAGER";
  const id = String(req.params.id ?? "");

  // 🔴 Scoped to THIS shop in the lookup, so an id from another shop is not
  // found rather than revoked. A manager may reach any connection in their own
  // shop; anyone else, only their own.
  const conn = await prisma.mcpConnection.findFirst({
    where: { id, shopId, ...(isManager ? {} : { userId }) },
    select: { id: true, revokedAt: true },
  });

  if (!conn) {
    // Indistinguishable from "already gone", deliberately: a 404 that only
    // appears for other people's connections is a membership oracle.
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (conn.revokedAt === null) {
    await revokeConnection(conn.id, "user");
    await logMcpAuth({
      shopId,
      userId,
      connectionId: conn.id,
      toolName: "connection.revoke",
      result: "OK",
    });
  }

  // Idempotent: disconnecting twice is a success both times. The button is
  // reached in a panic often enough that a second click must not show an error.
  res.status(204).end();
});
