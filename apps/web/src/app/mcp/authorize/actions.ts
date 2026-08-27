"use server";

import { apiSend } from "@/lib/api";

/**
 * Forward the consent to the API, which does all the real validation.
 *
 * This action exists only to attach the barber's session cookie server-side
 * (apiSend forwards it) so the browser never posts credentials cross-origin. It
 * deliberately performs NO checks of its own: duplicating the API's validation
 * here would create a second, weaker opinion about who may authorize what, and
 * the API must be safe against a caller that never loaded the page at all.
 */
export async function approveMcpAuthorization(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  state: string | null;
}): Promise<{ ok: true; redirectTo: string } | { ok: false; message: string }> {
  const res = await apiSend<{ redirect_to?: string }>("POST", "/mcp/oauth/authorize/approve", {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.state ? { state: input.state } : {}),
  });

  if (res.ok && res.data?.redirect_to) {
    return { ok: true, redirectTo: res.data.redirect_to };
  }

  // 🔴 Fixed copy per CATEGORY. The API's `error` is a stable OAuth code; its
  // `error_description` is not shown to the barber, because an authorization
  // error is the one place a message could carry something the caller supplied.
  const code = typeof res.error === "string" ? res.error : "";
  const message =
    code === "invalid_client"
      ? "ChairBack doesn't recognise that assistant. Start the connection again from the assistant itself."
      : code === "invalid_request"
        ? "That connection link isn't valid. Start again from your assistant."
        : code === "invalid_scope"
          ? "That assistant asked for something ChairBack doesn't offer yet."
          : code === "access_denied"
            ? "This account isn't part of a shop yet, so there's nothing to connect."
            : // 🔴 The plan refusal needs its OWN sentence. It fell through to
              // the generic "try again" line, which is the worst possible copy
              // for it: nothing about trying again changes a plan, so the
              // barber loops, and the assistant just reports "authorization
              // failed" with no reason a human can act on.
              code === "plan_required"
              ? "Connecting an AI assistant needs ChairBack Premium or Premium AI, or an active trial. Everything else in ChairBack is unaffected — this only stops the connection."
              : "Couldn't connect that assistant. Try starting the connection again.";
  return { ok: false, message };
}
