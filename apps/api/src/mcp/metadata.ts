import { apiEnv } from "@chairback/config";
import { ALL_SCOPES } from "@chairback/config/mcpScopes";

/**
 * The two discovery documents an MCP client fetches before it can authorize.
 *
 * ── How a client finds its way in, in order ──────────────────────────────────
 *
 *  1. It calls the MCP endpoint with no token and gets `401` plus a
 *     `WWW-Authenticate: Bearer resource_metadata="<url>"` header (RFC 9728 §5).
 *  2. It fetches that url - PROTECTED RESOURCE METADATA - which names this
 *     server as a `resource` and lists the authorization servers it trusts.
 *  3. It fetches the authorization server's metadata (RFC 8414) to learn the
 *     registration, authorize, token and revocation endpoints.
 *  4. It registers itself (RFC 7591), then runs the PKCE code flow.
 *
 * ChairBack is BOTH the resource server and the authorization server here. They
 * are still two separate documents because the spec treats them as separate
 * roles, and because splitting them later (a dedicated auth host) must not be a
 * breaking change for clients that cached the discovery chain.
 */

/**
 * The canonical resource identifier, and the value clients must send as
 * `resource` (RFC 8707). Every token is bound to it.
 *
 * 🔴 DERIVED FROM CONFIG, NEVER FROM THE REQUEST. Building this from the Host
 * header would let anyone who can reach the server with a spoofed Host mint a
 * token for a resource of their choosing, and would make the audience check
 * (which is the whole point of RFC 8707) self-fulfilling.
 */
export function mcpResourceUrl(): string {
  return `${apiEnv().API_BASE_URL.replace(/\/$/, "")}/mcp`;
}

/** The issuer, per RFC 8414. Bare origin, no trailing slash. */
export function mcpIssuer(): string {
  return apiEnv().API_BASE_URL.replace(/\/$/, "");
}

/** The URL that goes in the WWW-Authenticate challenge. */
export function protectedResourceMetadataUrl(): string {
  return `${mcpIssuer()}/.well-known/oauth-protected-resource`;
}

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * `bearer_methods_supported` is header-only on purpose: a token in a query
 * string ends up in access logs, browser history and Referer headers, and there
 * is no reason for a machine client to need it.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuer()],
    scopes_supported: [...ALL_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/dashboard/assistant`,
  };
}

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * Three entries are load-bearing rather than boilerplate:
 *
 *  - `code_challenge_methods_supported: ["S256"]` - `plain` is absent because
 *    OAuth 2.1 removed it and the token endpoint refuses it outright.
 *  - `token_endpoint_auth_methods_supported: ["none"]` - every MCP client is a
 *    PUBLIC client. We issue no client secret, so a secret cannot leak from a
 *    desktop app's config file. PKCE is what proves the caller.
 *  - `grant_types_supported` omits `implicit` and `password`, both removed by
 *    OAuth 2.1.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  const issuer = mcpIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/mcp/oauth/authorize`,
    token_endpoint: `${issuer}/mcp/oauth/token`,
    registration_endpoint: `${issuer}/mcp/oauth/register`,
    revocation_endpoint: `${issuer}/mcp/oauth/revoke`,
    scopes_supported: [...ALL_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    // RFC 8707. Advertised so a client knows to send `resource`; the token
    // endpoint requires it regardless of whether the client read this.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/dashboard/assistant`,
  };
}
