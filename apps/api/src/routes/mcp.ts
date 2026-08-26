import { Router } from "express";
import { requireMcpAuth } from "../middleware/mcpAuth.js";
import { mcpLimiter } from "../middleware/rateLimit.js";
import { logMcpEvent } from "../mcp/audit.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../mcp/metadata.js";

/**
 * The MCP surface.
 *
 * THIS PR SHIPS THE DOOR, NOT THE ROOMS. `tools/list` returns an empty list and
 * there is nothing to call. That is deliberate: the authorization story is the
 * part that is dangerous to get wrong, so it lands, gets reviewed and gets a
 * security pass on its own - before a single tool can read a customer's name.
 *
 * What IS live here:
 *   - the two discovery documents;
 *   - an authenticated JSON-RPC endpoint that proves the whole token lifecycle
 *     end to end (initialize, tools/list, ping);
 *   - a 401 that carries the RFC 9728 challenge, which is how a client that has
 *     never seen ChairBack finds the authorization server.
 */

/**
 * Discovery. PUBLIC and unauthenticated by definition - a client fetches these
 * precisely because it has no credentials yet.
 *
 * Mounted at the ROOT, not under /mcp: RFC 8414 and RFC 9728 both specify
 * `/.well-known/...` at the origin, and a client will not look anywhere else.
 */
export const mcpWellKnownRouter: Router = Router();

mcpWellKnownRouter.get("/.well-known/oauth-protected-resource", (_req, res) => {
  // Cacheable: it is public, static per deployment, and clients fetch it on
  // every cold start.
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(protectedResourceMetadata());
});

mcpWellKnownRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(authorizationServerMetadata());
});

/** The MCP endpoint proper. Everything past this point requires a bearer token. */
export const mcpRouter: Router = Router();

/**
 * JSON-RPC 2.0 error codes used here. `-32601` and `-32600` are the spec's;
 * everything else the transport needs is expressed as HTTP status.
 */
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_REQUEST = -32600;

/** MCP protocol revision this server implements. */
const PROTOCOL_VERSION = "2025-06-18";

mcpRouter.post("/", mcpLimiter, requireMcpAuth, async (req, res) => {
  const ctx = req.mcp!;
  const body = req.body as { jsonrpc?: string; id?: unknown; method?: unknown } | undefined;

  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: RPC_INVALID_REQUEST, message: "expected a JSON-RPC 2.0 request" },
    });
    return;
  }

  const id = body.id ?? null;
  const method = body.method;

  switch (method) {
    case "initialize":
      await logMcpEvent({
        shopId: ctx.shopId,
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        toolName: "initialize",
        operationType: "AUTH",
        result: "OK",
      });
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          // No capabilities are advertised yet - a client must not be told it
          // can call tools that do not exist.
          capabilities: { tools: {} },
          serverInfo: { name: "chairback", version: "1.0.0" },
        },
      });
      return;

    case "tools/list":
      // Empty, on purpose. The read-only tools land in the next PR, each behind
      // its own scope gate.
      res.json({ jsonrpc: "2.0", id, result: { tools: [] } });
      return;

    case "ping":
      res.json({ jsonrpc: "2.0", id, result: {} });
      return;

    case "tools/call":
      await logMcpEvent({
        shopId: ctx.shopId,
        userId: ctx.userId,
        connectionId: ctx.connectionId,
        toolName: "tools/call",
        operationType: "READ",
        result: "DENIED",
        failureCode: "no_tools_yet",
      });
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: "this server exposes no tools yet" },
      });
      return;

    default:
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: "unknown method" },
      });
  }
});

/**
 * A GET on the MCP endpoint exists ONLY so an unauthenticated client gets the
 * RFC 9728 challenge and can start discovery. It never returns data.
 */
mcpRouter.get("/", mcpLimiter, requireMcpAuth, (_req, res) => {
  res.status(405).json({
    error: "method_not_allowed",
    error_description: "use POST with a JSON-RPC 2.0 body",
  });
});
