import { Router } from "express";
import { requireMcpAuth } from "../middleware/mcpAuth.js";
import { mcpLimiter } from "../middleware/rateLimit.js";
import { logMcpEvent } from "../mcp/audit.js";
import {
  buildInstructions,
  callTool,
  listTools,
  toolContextFor,
  type McpRequestContext,
} from "../mcp/dispatch.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../mcp/metadata.js";

/**
 * The MCP surface.
 *
 * PR B shipped the door; this is the first set of rooms, and every one of them
 * is read-only. The authorization story landed, was reviewed cold and was
 * hardened by a hotfix BEFORE any tool could read a customer's name - which is
 * why the interesting code here is short: it asks `decideTool` whether this
 * caller may run this tool, and does as it is told.
 *
 * 🔴 THE ROUTER MAKES NO PERMISSION DECISIONS OF ITS OWN. Not one `if (role
 * === ...)` lives in this file. Everything is in `mcp/toolPolicy.ts`, where the
 * whole matrix can be read at once and is asserted cell by cell - the
 * alternative, a check per handler, is ten chances to forget the lapsed case.
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
const RPC_INVALID_PARAMS = -32602;

/**
 * Narrow the authenticated request context to what the dispatcher needs.
 *
 * 🔴 THE POINT IS WHAT IS *NOT* PASSED. The dispatcher gets identity and grant
 * only - no Request, no headers, no body. It cannot reach anything the client
 * sent even by accident, which is what makes "a staffId is never read from the
 * request" checkable by reading one function rather than ten.
 */
function session(ctx: NonNullable<Express.Request["mcp"]>): McpRequestContext {
  return {
    connectionId: ctx.connectionId,
    userId: ctx.userId,
    shopId: ctx.shopId,
    role: ctx.role,
    staffId: ctx.staffId,
    accessLevel: ctx.accessLevel,
    scopes: ctx.scopes,
    billing: ctx.billing,
    vocabulary: ctx.vocabulary,
  };
}

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
          // `listChanged` is false: the set of tools a caller may run changes
          // only when the human re-consents or their seat changes, and both of
          // those already invalidate the connection rather than mutate it.
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "chairback", version: "1.0.0" },
          // Safe connection context: what this business calls its people and
          // visits, so the assistant asks "which nail tech?" rather than
          // "which barber?".
          //
          // 🔴 SERVER-AUTHORED, and deliberately here rather than inside a
          // tool's `data` envelope. Everything a tool returns is shop-supplied
          // text wrapped as untrusted; this is the one channel the server
          // itself speaks on. It interpolates ONLY fixed registry words - never
          // a string the shop typed - which is what makes that safe.
          //
          // Presentation ONLY: it changes wording, never scopes, role, tenant
          // isolation, entitlement or which tools are listed.
          instructions: buildInstructions(ctx.vocabulary),
        },
      });
      return;

    case "tools/list": {
      // 🔴 FILTERED, NOT ANNOTATED. A model shown a tool it cannot call will
      // call it, be refused, rephrase and call it again - and the presence of a
      // denied entry would itself say something about the shop.
      const toolCtx = toolContextFor(session(ctx));
      res.json({ jsonrpc: "2.0", id, result: { tools: listTools(toolCtx) } });
      return;
    }

    case "ping":
      res.json({ jsonrpc: "2.0", id, result: {} });
      return;

    case "tools/call": {
      const params = (body as { params?: { name?: unknown; arguments?: unknown } }).params;
      if (!params || typeof params !== "object") {
        res.status(400).json({
          jsonrpc: "2.0",
          id,
          error: { code: RPC_INVALID_PARAMS, message: "params.name is required" },
        });
        return;
      }
      // A permission failure comes back as an MCP tool RESULT with isError, not
      // a JSON-RPC error: the model is meant to read "you can't do that, here's
      // why" and stop, which a transport-level error does not let it do.
      const outcome = await callTool(session(ctx), params.name, params.arguments);
      res.json({ jsonrpc: "2.0", id, result: outcome });
      return;
    }

    default:
      // 🔴 A JSON-RPC NOTIFICATION HAS NO id AND EXPECTS NO REPLY. Every
      // spec-compliant MCP client sends `notifications/initialized` the moment
      // the handshake completes; answering it 404 with an error body made a
      // correct client look like a failed one, and a strict one tear the
      // session down. 202 with an empty body is what the spec asks for.
      if (typeof method === "string" && method.startsWith("notifications/")) {
        res.status(202).end();
        return;
      }
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
