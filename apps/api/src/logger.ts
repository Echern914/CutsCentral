import { pino } from "pino";
import { apiEnv } from "@chairback/config";

const env = apiEnv();

/**
 * Structured logger. Redacts secrets so tokens never land in logs.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.accessToken",
      "*.refreshToken",
      "*.passwordHash",
      "*.password",
      "accessToken",
      "refreshToken",
      "TOKEN_ENCRYPTION_KEY",
      "SESSION_SECRET",
      // Belt and braces behind logRedaction.ts's res serializer: if a response
      // object is ever hand-logged instead of going through pino-http, the
      // session cookie and the redirect target still never reach stdout.
      'res.headers["set-cookie"]',
      "res.headers.location",
    ],
    censor: "[redacted]",
  },
  // pino-pretty only in real dev runs; tests + prod use plain JSON so a missing
  // transport module can never break the process.
  transport:
    env.NODE_ENV === "development" && process.env.VITEST !== "true"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
