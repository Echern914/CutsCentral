import type { NextFunction, Request, Response } from "express";
import { apiEnv } from "@chairback/config";

const env = apiEnv();

/**
 * Minimal CORS for the web app origin, with credentials so the session cookie
 * flows on dashboard requests. Single allowed origin (APP_BASE_URL) - no
 * wildcard, which is required when credentials are allowed.
 */
export function corsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.header("Access-Control-Allow-Origin", env.APP_BASE_URL);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
