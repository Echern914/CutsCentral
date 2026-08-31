import "express-async-errors"; // MUST import before routes: routes async rejections to the error middleware (Express 4 doesn't)
import cookieParser from "cookie-parser";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { pinoHttp } from "pino-http";
import { apiEnv } from "@chairback/config";
import { logger } from "./logger.js";
import { authRouter } from "./routes/auth.js";
import { passwordResetRouter } from "./routes/passwordReset.js";
import { authMobileRouter } from "./routes/authMobile.js";
import { authAppleRouter } from "./routes/authApple.js";
import { emailChangeRouter } from "./routes/emailChange.js";
import { healthRouter } from "./routes/health.js";
import { publicPageRouter, shopsRouter } from "./routes/shops.js";
import { domainsRouter } from "./routes/domains.js";
import { uploadRouter } from "./routes/upload.js";
import { acuityWebhookRouter } from "./routes/webhooks.acuity.js";
import { squareWebhookRouter } from "./routes/webhooks.square.js";
import { twilioWebhookRouter } from "./routes/webhooks.twilio.js";
import { resendWebhookRouter } from "./routes/webhooks.resend.js";
import { acuityOAuthRouter } from "./routes/acuity.oauth.js";
import { stripeConnectOAuthRouter } from "./routes/stripeConnect.oauth.js";
import { mcpRouter, mcpWellKnownRouter } from "./routes/mcp.js";
import { mcpOAuthRouter } from "./routes/mcp.oauth.js";
import { squareOAuthRouter } from "./routes/square.oauth.js";
import { adminRouter } from "./routes/admin.js";
import { rewardsRouter } from "./routes/rewards.js";
import { rewardsRecoveryRouter } from "./routes/rewardsRecovery.js";
import { walletRouter } from "./routes/wallet.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { barberRouter } from "./routes/barber.js";
import { barberClientsRouter } from "./routes/barberClients.js";
import { walkInBarberRouter } from "./routes/walkIn.barber.js";
import { walkInPublicRouter } from "./routes/walkIn.public.js";
import { walkInDashboardRouter } from "./routes/walkIn.dashboard.js";
import { insightsRouter } from "./routes/insights.js";
import { notificationsRouter } from "./routes/notifications.js";
import { mcpConnectionsRouter } from "./routes/mcp.connections.js";
import { readinessRouter } from "./routes/readiness.js";
import { teamRouter } from "./routes/team.js";
import { teamJoinRouter } from "./routes/teamJoin.js";
import { bookingPublicRouter } from "./routes/booking.public.js";
import { bookingDashboardRouter } from "./routes/booking.dashboard.js";
import { loyaltyRouter } from "./routes/loyalty.js";
import { promotionsRouter } from "./routes/promotions.js";
import { billingRouter } from "./routes/billing.js";
import { stripeWebhookRouter } from "./routes/webhooks.stripe.js";
import { connectWebhookRouter } from "./routes/webhooks.connect.js";
import { paymentsDashboardRouter } from "./routes/payments.dashboard.js";
import { adminPortalRouter } from "./routes/adminPortal.js";
import { demoRouter } from "./routes/demo.js";
import { captureError } from "./sentry.js";
import {
  redactedReqSerializer,
  redactedResSerializer,
  redactUrl,
  requestUrl,
} from "./logRedaction.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requireAdminIp } from "./middleware/adminIp.js";
import {
  adminLimiter,
  dashboardLimiter,
  mcpIpLimiter,
  oauthLimiter,
  rewardsLimiter,
  webhookLimiter,
} from "./middleware/rateLimit.js";

const env = apiEnv();

/**
 * Express app factory. No listen() here so tests can import the app directly.
 *
 * ORDER MATTERS:
 *  1. Webhook routers mount FIRST with their own body parsers (Acuity needs the
 *     raw body for HMAC; Twilio needs urlencoded). They must run before the
 *     global express.json() so the raw bytes survive.
 *  2. Global cookie + JSON parsing.
 *  3. JSON API routers.
 *  4. The 4-arg error middleware LAST - with express-async-errors above, every
 *     thrown/rejected route lands here instead of killing the process.
 */
export function createApp(): Express {
  const app = express();

  // Railway terminates TLS at a proxy; without this req.ip is the proxy for
  // every request and all per-IP rate limits collapse into one shared bucket.
  app.set("trust proxy", 1);

  // 🔴 BOTH serializers, on purpose. Overriding only `req` leaves pino-http's
  // default `res` serializer emitting every response header - which is how
  // the session cookie spent months on stdout while the request side was
  // being carefully redacted.
  app.use(
    pinoHttp({
      logger,
      serializers: { req: redactedReqSerializer, res: redactedResSerializer },
    }),
  );
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(corsMiddleware);

  // Health check (no body needed).
  app.use(healthRouter);

  // MCP DISCOVERY. Public, unauthenticated, and mounted at the ORIGIN root
  // because RFC 8414 and RFC 9728 both specify /.well-known/... there - a
  // client will not look anywhere else. Registered before the body parsers
  // because these are GETs with no body.
  app.use(mcpWellKnownRouter);

  // (1) Webhooks - each mounts its own body parser internally. Rate-limited per
  // IP (generous; legit bursts happen) to bound DoS if a secret leaks.
  app.use("/webhooks/acuity", webhookLimiter, acuityWebhookRouter);
  app.use("/webhooks/square", webhookLimiter, squareWebhookRouter);
  app.use("/webhooks/twilio", webhookLimiter, twilioWebhookRouter);
  // Email delivery events (bounce/complaint/delivered) - see webhooks.resend.
  app.use("/webhooks/resend", webhookLimiter, resendWebhookRouter);
  app.use("/webhooks/stripe", webhookLimiter, stripeWebhookRouter);
  app.use("/webhooks/stripe-connect", webhookLimiter, connectWebhookRouter);

  // (2) Global parsers for the rest of the app.
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // (3) JSON API.
  app.use("/api/auth", authRouter); // signup/login limited inside the router
  app.use("/api/demo", demoRouter); // public read-only demo dashboard session (limited inside)
  // Forgot/reset password lives in its own router (composes with authRouter on
  // the same mount; sensitive POSTs use authLimiter inside, like signup/login).
  app.use("/api/auth", passwordResetRouter);
  // Browser-to-app session handoff for the invited-barber "Join your shop"
  // flow. Same mount, own router; limits are applied per route inside.
  app.use("/api/auth", authMobileRouter);
  // Sign in with Apple on the web. Dark until the Apple env vars are set.
  app.use("/api/auth", authAppleRouter);
  // Change-login-email: same composition pattern (verify-the-new-inbox flow).
  app.use("/api/auth", emailChangeRouter);
  app.use("/api/shops", shopsRouter);
  // Custom shop domain lifecycle (owner-facing; the public resolve lives on
  // /api/page/-/by-domain with the other public page reads).
  app.use("/api/domains", dashboardLimiter, domainsRouter);
  // Photo upload proxy. Uses a per-route express.raw() parser (image/*), so the
  // global express.json() above leaves its body untouched. Limited per-user.
  app.use("/api", uploadRouter);
  // REMOTE MCP SERVER.
  //
  // 🔴 NOT under /api, and deliberately so: `resource` in every token is
  // `<API_BASE_URL>/mcp`, and that string is what an MCP client stores and what
  // the audience check compares against. Moving the mount later would invalidate
  // every issued token, so it is fixed here and asserted in the tests.
  //
  // The OAuth sub-router carries its own per-route limits; the MCP endpoint
  // keys its limiter on the bearer token rather than the IP (see mcpLimiter).
  app.use("/mcp/oauth", mcpOAuthRouter);
  // 🔴 ORDER IS THE FIX. The IP limiter is mounted on the path, ahead of the
  // router, so a rejected request is answered before anything hashes a bearer
  // or touches the database. Inside the router each route then applies
  // `mcpLimiter` (per-connection fair-sharing) and only then `requireMcpAuth`.
  app.use("/mcp", mcpIpLimiter, mcpRouter);

  // Stripe Connect STANDARD onboarding. Mounted here, NOT under the payments
  // dashboard router, because /callback is a redirect back from Stripe with no
  // session on it - it authenticates via its signed state cookie instead.
  app.use("/api/payments/connect/oauth", oauthLimiter, stripeConnectOAuthRouter);
  app.use("/api/acuity/oauth", oauthLimiter, acuityOAuthRouter);
  app.use("/api/square/oauth", oauthLimiter, squareOAuthRouter);
  // Phone-verified rewards recovery (per-route limiters inside). Mounted on
  // its own prefix so /api/rewards' blanket limiter cannot starve it.
  app.use("/api/rewards-recovery", rewardsRecoveryRouter);
  app.use("/api/rewards", rewardsLimiter, rewardsRouter);
  app.use("/api/wallet", rewardsLimiter, walletRouter); // Apple Wallet pass web service (public, ApplePass-token auth)
  app.use("/api/page", rewardsLimiter, publicPageRouter); // public shop pages
  app.use("/api/book", bookingPublicRouter); // public native booking (per-route limits inside)
  // Walk-In Mode public surface: the kiosk tablet + "My Place in Line".
  // Per-route limits inside; every credential rides in a POST body, never a
  // URL. Dark behind WALK_IN_MODE_ENABLED (the router 404s wholesale).
  app.use("/api/walk-in", walkInPublicRouter);
  // Team seats + the join flow. teamJoinRouter is mounted FIRST and requires
  // only a session: accepting an invite happens before the user belongs to any
  // shop, so it must not sit behind requireShop.
  app.use("/api/team/join", dashboardLimiter, teamJoinRouter);
  app.use("/api/team", dashboardLimiter, teamRouter);

  // Existing dashboard surface. The employee (BARBER) role is refused inside
  // each of these routers, right after their own requireShop — see
  // `requireManager` in auth/roles.ts. It can't be gated here at the mount:
  // these routers resolve the session themselves, so req.shopRole isn't set
  // until their own middleware has run.
  //
  // 🔑 THE WALL, written down once. ChairBack is ONE plan; when the trial ends
  // and no subscription is live the shop stops working. `requireActiveAccess`
  // is appended to each router's own requireShop line for the same reason the
  // role gate is - req.shop does not exist yet at this mount point.
  //
  //   WALLED (whole router)  /api/booking  /api/payments  /api/promos
  //                          /api/insights /api/loyalty   /api/notifications
  //                          /api/barber   /api/team      /api/domains
  //   WALLED (per route)     /api/shops PATCH /me, POST /me/sms-preview
  //   WALLED (except reads)  /api/dashboard - GET of the client book and the
  //                          CSV exports stay open (middleware/wallExemptions)
  //   NEVER WALLED           /api/billing  /api/auth  /api/admin-portal
  //                          /api/readiness (read-only; a lapsed shop must be
  //                          able to see why it stopped taking bookings),
  //                          /api/shops GET /me (the billing page needs it),
  //                          DELETE /me (deleting your account is a right),
  //                          POST / (creating a shop starts the trial),
  //                          /api/team/join, and every PUBLIC router - those
  //                          serve the shop's CLIENTS, not the barber. A
  //                          lapsed shop's page says so instead of 404ing.
  app.use("/api/dashboard", dashboardLimiter, dashboardRouter);
  // Own-chair surface for employees. Deliberately NOT part of dashboardRouter:
  // that router is manager-gated so new routes inherit the restriction.
  // The walk-in claim surface mounts FIRST (more specific path) so the barber
  // router can never shadow it. Both dark behind WALK_IN_MODE_ENABLED.
  app.use("/api/barber/walk-ins", dashboardLimiter, walkInBarberRouter);
  // The barber's own clientele (people their chair has served) - same
  // more-specific-first mounting so barberRouter can never shadow it.
  app.use("/api/barber/clients", dashboardLimiter, barberClientsRouter);
  app.use("/api/barber", dashboardLimiter, barberRouter);
  app.use("/api/insights", dashboardLimiter, insightsRouter); // barber analytics page
  app.use("/api/notifications", dashboardLimiter, notificationsRouter); // the barber's own alert settings
  // Launch readiness (READ-ONLY). NEVER WALLED on purpose - see the router's
  // own note: a lapsed shop has to be able to read WHY booking stopped, and
  // "your subscription lapsed" is one of the answers it reports. It carries
  // its own dashboardLimiter, auth and shop scoping.
  app.use("/api/readiness", readinessRouter);
  // The barber's own list of connected assistants, and the disconnect button.
  // NEVER WALLED and never plan-gated: a shop that lapsed or downgraded must
  // still be able to SEE and REVOKE what it connected while it was paying.
  app.use("/api/mcp", mcpConnectionsRouter);
  app.use("/api/booking", dashboardLimiter, bookingDashboardRouter); // barber booking config
  // Walk-In Mode manager surface (the Live Queue board). Its own router, NOT
  // part of bookingDashboardRouter (the Square stack edits that file, and a
  // queue is not booking config). Dark behind WALK_IN_MODE_ENABLED.
  app.use("/api/walk-ins", dashboardLimiter, walkInDashboardRouter);
  app.use("/api/payments", dashboardLimiter, paymentsDashboardRouter); // barber payment settings
  app.use("/api/loyalty", dashboardLimiter, loyaltyRouter);
  app.use("/api/promos", dashboardLimiter, promotionsRouter);
  app.use("/api/billing", dashboardLimiter, billingRouter);
  // The operator surface gets an optional IP allowlist (requireAdminIp) ahead of
  // its credential gates. Fail-open when ADMIN_IP_ALLOWLIST is unset.
  app.use("/api/admin-portal", requireAdminIp, dashboardLimiter, adminPortalRouter);
  app.use("/admin", requireAdminIp, adminLimiter, adminRouter);

  // Fallback 404 for unknown API routes.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // (4) Final error handler: log everything, leak nothing. Body-parser
  // failures (broken JSON, >100kb payloads) are caller mistakes any client can
  // trigger at will - answer 4xx and skip Sentry, or they'd be endless noise.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const bodyErrorType = (err as { type?: string } | null)?.type;
    if (bodyErrorType === "entity.parse.failed" || bodyErrorType === "entity.too.large") {
      logger.warn(
        { path: redactUrl(requestUrl(req)), method: req.method, bodyErrorType },
        "unreadable request body",
      );
      if (res.headersSent) return;
      if (bodyErrorType === "entity.parse.failed") res.status(400).json({ error: "bad_json" });
      else res.status(413).json({ error: "payload_too_large" });
      return;
    }
    // 🔴 REDACTED, and via originalUrl rather than req.path. Half the routes
    // that can throw here carry their credential IN THE PATH, and this line is
    // the one that gets forwarded out of the log stream to wherever alerts go.
    const path = redactUrl(requestUrl(req));
    logger.error({ err, path, method: req.method }, "request failed");
    captureError(err, { path, method: req.method });
    if (res.headersSent) return;
    res.status(500).json({ error: "internal" });
  });

  return app;
}

/** Baseline security headers for a JSON API (helmet-lite, no dependency). */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains",
    );
  }
  next();
}
