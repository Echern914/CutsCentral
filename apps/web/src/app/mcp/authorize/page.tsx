import { redirect } from "next/navigation";
import { SCOPE_LABELS } from "@chairback/config/mcpScopes";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { Card } from "@/components/ui/Card";
import { ApproveForm } from "./ApproveForm";

/**
 * The consent screen: the one moment a human grants an AI assistant access to
 * their shop.
 *
 * 🔴 WHY THIS PAGE EXISTS AT ALL. Consent has to be a FIRST-PARTY, authenticated
 * action on ChairBack's own origin. The assistant never sees, handles or proxies
 * a ChairBack credential — it sends the barber here, the barber signs in to
 * ChairBack as they always do, and what comes back to the assistant is an
 * authorization code, not a password. Any design where the client collects
 * ChairBack credentials is the phishing pattern this whole flow exists to avoid.
 *
 * 🔴 THIS PAGE IS A COURTESY, NOT A TRUST BOUNDARY. Every value shown here is
 * re-validated from scratch by the API when the form POSTs: the client, the
 * redirect URI (exact match against its registered list), the resource, the
 * scopes, and — critically — WHICH SHOP, which comes from the session and is
 * never read from this page's query string. A request that skipped this page
 * entirely is exactly as safe as one that did not.
 *
 * The client's own name is displayed as an untrusted label. It is whatever the
 * client typed at registration, so it is rendered as text and never used to
 * decide anything.
 */
export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const me = await getMe();

  const str = (k: string): string | null => {
    const v = searchParams[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  // The middleware gates /mcp/* on the session cookie existing; this catches a
  // stale or revoked one, which the cookie's presence cannot rule out.
  //
  // 🔴 The authorization request is REBUILT into `next`. The old form hardcoded
  // "/login?next=/mcp/authorize", which threw away the client, the PKCE
  // challenge and the state - so a barber with an expired cookie signed in and
  // arrived at a consent screen that had nothing to consent to.
  if (me.status === 401 || !me.data) {
    const resume = new URLSearchParams();
    for (const key of [
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
      "state",
    ]) {
      const v = str(key);
      if (v) resume.set(key, v);
    }
    const qs = resume.toString();
    redirect(`/login?next=${encodeURIComponent(`/mcp/authorize${qs ? `?${qs}` : ""}`)}`);
  }

  const clientId = str("client_id");
  const redirectUri = str("redirect_uri");
  const codeChallenge = str("code_challenge");
  const resource = str("resource");
  const scope = str("scope");
  const state = str("state");

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <Shell>
        <h1 className="font-display text-2xl tracking-tight">That link isn&apos;t complete</h1>
        <p className="mt-2 text-sm text-muted">
          Start the connection again from your assistant. If it keeps happening,
          the assistant is sending ChairBack an incomplete authorization request.
        </p>
      </Shell>
    );
  }

  // 🔴 ASK THE API WHAT THIS CLIENT ACTUALLY REGISTERED. This page is reachable
  // directly, so every query parameter is attacker-controlled: rendering the
  // client's name from the URL would let anyone send a barber to a page saying
  // "ChairBack Official" that points at their own server.
  const info = await apiGet<{
    client_name: string;
    redirect_uris: string[];
  }>(`/mcp/oauth/client-info?client_id=${encodeURIComponent(clientId)}`);

  if (!info.ok || !info.data) {
    return (
      <Shell>
        <h1 className="font-display text-2xl tracking-tight">ChairBack doesn&apos;t know that assistant</h1>
        <p className="mt-2 text-sm text-muted">
          Start the connection again from the assistant itself. Nothing has been
          shared.
        </p>
      </Shell>
    );
  }

  // 🔴 And refuse to render a consent form for a destination this client never
  // registered. The API would refuse the approval anyway, but showing the form
  // first would mean a barber can be walked all the way to a button that looks
  // like it grants access to their shop.
  if (!info.data.redirect_uris.includes(redirectUri)) {
    return (
      <Shell>
        <h1 className="font-display text-2xl tracking-tight">That connection link has been tampered with</h1>
        <p className="mt-2 text-sm text-muted">
          It asks ChairBack to send your shop&apos;s data somewhere the assistant
          never registered. Nothing has been shared. Start the connection again
          from the assistant itself.
        </p>
      </Shell>
    );
  }

  const scopes = (scope ?? "").split(/\s+/).filter(Boolean);
  const shopName = me.data.activeShopName ?? me.data.shops?.[0]?.name ?? "your shop";
  const roleLabel =
    me.data.shopRole === "BARBER" ? "your chair" : me.data.shopRole === "MANAGER" ? "manager" : "owner";

  return (
    <Shell>
      <h1 className="font-display text-2xl tracking-tight">Connect your assistant</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        An assistant is asking to read information from{" "}
        <span className="text-offwhite">{shopName}</span>.
      </p>

      <Card className="mt-5 px-5 py-4">
        <dl className="space-y-3 text-sm">
          <Row label="Assistant">
            {/* SELF-DECLARED. React escapes it, and the label below says so, but
                a name is still the most useful thing a human has for telling
                one connection attempt from another. */}
            <span className="text-offwhite">{info.data.client_name}</span>
          </Row>
          <Row label="Sends data to">
            {/* The part an attacker cannot fake without also controlling the
                destination — which is why it is shown next to the name. */}
            <span className="break-all text-offwhite">{hostOf(redirectUri)}</span>
          </Row>
          <Row label="Shop">
            <span className="text-offwhite">{shopName}</span>
          </Row>
          <Row label="Signed in as">
            <span className="text-offwhite">
              {me.data.email} · {roleLabel}
            </span>
          </Row>
          <Row label="Access">
            <span className="text-offwhite">Read-only</span>
          </Row>
        </dl>
      </Card>

      <p className="mt-2 text-xs text-muted">
        The assistant&apos;s name is what that software calls itself. Only connect
        one you started yourself.
      </p>

      <section className="mt-5">
        <h2 className="text-xs uppercase tracking-[0.16em] text-muted">It will be able to</h2>
        <ul className="mt-2 space-y-1.5">
          {scopes.length === 0 ? (
            <li className="text-sm text-muted">Read ChairBack help and your setup progress</li>
          ) : (
            scopes.map((s) => (
              <li key={s} className="flex items-start gap-2 text-sm text-offwhite">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-gold" aria-hidden />
                {SCOPE_LABELS[s] ?? s}
              </li>
            ))
          )}
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          It <span className="text-offwhite">cannot</span> change anything in your
          account — no bookings, no prices, no messages to your clients. Your AI
          provider handles the conversation and its usage under your own plan;
          ChairBack never charges you for AI. You can disconnect at any time from
          Assistant → Connections.
        </p>
      </section>

      <ApproveForm
        clientId={clientId}
        redirectUri={redirectUri}
        codeChallenge={codeChallenge}
        resource={resource}
        scope={scope}
        state={state}
      />
    </Shell>
  );
}

/**
 * Where the authorization code will be delivered, as a human reads it. A
 * loopback address is named as such rather than shown as a bare IP, because
 * "127.0.0.1" means nothing to a barber and "an app on this computer" does.
 */
function hostOf(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    if (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1") {
      return "an app on this device";
    }
    return u.host || u.protocol.replace(":", "");
  } catch {
    return redirectUri.slice(0, 60);
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-lg px-5 py-10">{children}</main>;
}
