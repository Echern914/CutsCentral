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
import { healthRouter } from "./routes/health.js";
import { publicPageRouter, shopsRouter } from "./routes/shops.js";
import { uploadRouter } from "./routes/upload.js";
import { acuityWebhookRouter } from "./routes/webhooks.acuity.js";
import { squareWebhookRouter } from "./routes/webhooks.square.js";
import { twilioWebhookRouter } from "./routes/webhooks.twilio.js";
import { acuityOAuthRouter } from "./routes/acuity.oauth.js";
import { squareOAuthRouter } from "./routes/square.oauth.js";
import { adminRouter } from "./routes/admin.js";
import { rewardsRouter } from "./routes/rewards.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { bookingPublicRouter } from "./routes/booking.public.js";
import { bookingDashboardRouter } from "./routes/booking.dashboard.js";
import { loyaltyRouter } from "./routes/loyalty.js";
import { promotionsRouter } from "./routes/promotions.js";
import { billingRouter } from "./routes/billing.js";
import { stripeWebhookRouter } from "./routes/webhooks.stripe.js";
import { connectWebhookRouter } from "./routes/webhooks.connect.js";
import { paymentsDashboardRouter } from "./routes/payments.dashboard.js";
import { adminPortalRouter } from "./routes/adminPortal.js";
import { captureError } from "./sentry.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requireAdminIp } from "./middleware/adminIp.js";
import {
  adminLimiter,
  dashboardLimiter,
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

  app.use(pinoHttp({ logger, serializers: { req: redactedReqSerializer } }));
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(corsMiddleware);

  // Health check (no body needed).
  app.use(healthRouter);

  // (1) Webhooks - each mounts its own body parser internally. Rate-limited per
  // IP (generous; legit bursts happen) to bound DoS if a secret leaks.
  app.use("/webhooks/acuity", webhookLimiter, acuityWebhookRouter);
  app.use("/webhooks/square", webhookLimiter, squareWebhookRouter);
  app.use("/webhooks/twilio", webhookLimiter, twilioWebhookRouter);
  app.use("/webhooks/stripe", webhookLimiter, stripeWebhookRouter);
  app.use("/webhooks/stripe-connect", webhookLimiter, connectWebhookRouter);

  // (2) Global parsers for the rest of the app.
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // (3) JSON API.
  app.use("/api/auth", authRouter); // signup/login limited inside the router
  app.use("/api/shops", shopsRouter);
  // Photo upload proxy. Uses a per-route express.raw() parser (image/*), so the
  // global express.json() above leaves its body untouched. Limited per-user.
  app.use("/api", uploadRouter);
  app.use("/api/acuity/oauth", oauthLimiter, acuityOAuthRouter);
  app.use("/api/square/oauth", oauthLimiter, squareOAuthRouter);
  app.use("/api/rewards", rewardsLimiter, rewardsRouter);
  app.use("/api/page", rewardsLimiter, publicPageRouter); // public shop pages
  app.use("/api/book", bookingPublicRouter); // public native booking (per-route limits inside)
  app.use("/api/dashboard", dashboardLimiter, dashboardRouter);
  app.use("/api/booking", dashboardLimiter, bookingDashboardRouter); // barber booking config
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

  // (4) Final error handler: log everything, leak nothing.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path, method: req.method }, "request failed");
    captureError(err, { path: req.path, method: req.method });
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

/**
 * pino-http req serializer that masks the Acuity webhook path secret - the URL
 * is that route's only authenticator, so it must never land in logs verbatim.
 */
function redactedReqSerializer(req: {
  method?: string;
  url?: string;
  [k: string]: unknown;
}) {
  const url =
    typeof req.url === "string"
      ? req.url.replace(/(\/webhooks\/acuity\/)[^/?]+/, "$1[redacted]")
      : req.url;
  return { method: req.method, url };
}
