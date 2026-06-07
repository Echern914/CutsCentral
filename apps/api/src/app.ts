import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { shopsRouter } from "./routes/shops.js";
import { acuityWebhookRouter } from "./routes/webhooks.acuity.js";
import { twilioWebhookRouter } from "./routes/webhooks.twilio.js";
import { acuityOAuthRouter } from "./routes/acuity.oauth.js";
import { adminRouter } from "./routes/admin.js";
import { rewardsRouter } from "./routes/rewards.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { corsMiddleware } from "./middleware/cors.js";
import {
  adminLimiter,
  dashboardLimiter,
  oauthLimiter,
  rewardsLimiter,
  webhookLimiter,
} from "./middleware/rateLimit.js";

/**
 * Express app factory. No listen() here so tests can import the app directly.
 *
 * ORDER MATTERS:
 *  1. Webhook routers mount FIRST with their own body parsers (Acuity needs the
 *     raw body for HMAC; Twilio needs urlencoded). They must run before the
 *     global express.json() so the raw bytes survive.
 *  2. Global cookie + JSON parsing.
 *  3. JSON API routers.
 */
export function createApp(): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.disable("x-powered-by");
  app.use(corsMiddleware);

  // Health check (no body needed).
  app.use(healthRouter);

  // (1) Webhooks - each mounts its own body parser internally. Rate-limited per
  // IP (generous; legit bursts happen) to bound DoS if a secret leaks.
  app.use("/webhooks/acuity", webhookLimiter, acuityWebhookRouter);
  app.use("/webhooks/twilio", webhookLimiter, twilioWebhookRouter);

  // (2) Global parsers for the rest of the app.
  app.use(express.json());
  app.use(cookieParser());

  // (3) JSON API.
  app.use("/api/auth", authRouter); // signup/login limited inside the router
  app.use("/api/shops", shopsRouter);
  app.use("/api/acuity/oauth", oauthLimiter, acuityOAuthRouter);
  app.use("/api/rewards", rewardsLimiter, rewardsRouter);
  app.use("/api/dashboard", dashboardLimiter, dashboardRouter);
  app.use("/admin", adminLimiter, adminRouter);

  // Fallback 404 for unknown API routes.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
