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
  app.use("/webhooks/twilio", webhookLimiter, twilioWebhookRouter);

  // (2) Global parsers for the rest of the app.
  app.use(express.json({ limit: "100kb" }));
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

  // (4) Final error handler: log everything, leak nothing.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path, method: req.method }, "request failed");
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
