import { z } from "zod";

/**
 * Env validation. Split into apiEnv() (server, needs everything) and webEnv()
 * (the Next app, needs only the origins). Both crash loudly on missing vars.
 *
 * Call these once at boot and reuse the returned object - do not read process.env
 * scattered through the codebase.
 */

const boolish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

// URL env var that tolerates stray edge whitespace from copy-paste. Plain .trim()
// leaves zero-width space (U+200B-200D), BOM (U+FEFF), and word-joiner (U+2060) -
// invisible chars that still pass .url() and then poison every `${url}/path` we
// build (a leading space breaks CORS Allow-Origin matching and 302 Location headers).
// transform-then-pipe so the cleaned value is what gets validated and stored.
const STRIP_EDGES = /^[\s\u200B-\u200D\uFEFF\u2060]+|[\s\u200B-\u200D\uFEFF\u2060]+$/g;
const cleanUrl = () =>
  z.string().transform((v) => v.replace(STRIP_EDGES, "")).pipe(z.string().url());

const apiSchema = z.object({
  DATABASE_URL: cleanUrl(),
  // Direct (non-pooled) connection for prisma migrate. Optional at app runtime.
  DIRECT_URL: cleanUrl().optional(),

  APP_BASE_URL: cleanUrl(),
  API_BASE_URL: cleanUrl(),

  SESSION_SECRET: z.string().min(16),
  // Must decode to exactly 32 bytes (AES-256 key). Validate at boot so a
  // malformed key crashes the process loudly here rather than at the first
  // token encrypt/decrypt deep in a request. Mirrors loadKey() in crypto.ts.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message:
        "must decode to 32 bytes (base64). Generate with: openssl rand -base64 32",
    }),
  // Platform-operator token guarding /admin/* (backfill, sweeps, promotion).
  ADMIN_TOKEN: z.string().min(8).optional(),
  // Optional IP allowlist for the operator surface (/admin + /api/admin-portal).
  // Comma-separated IPs (IPv4 or IPv6). When set, requests from any other IP get
  // a 404 even with a valid admin session/token. When UNSET/empty the check is
  // skipped (fail-open) so you can never lock yourself out by misconfiguring it.
  ADMIN_IP_ALLOWLIST: z.string().optional().default(""),

  ACUITY_OAUTH_CLIENT_ID: z.string().min(1),
  ACUITY_OAUTH_CLIENT_SECRET: z.string().min(1),
  ACUITY_OAUTH_REDIRECT_URI: cleanUrl(),
  // Acuity webhook HMAC signing key. OAuth dynamic webhooks don't document a
  // per-app key today, so this is optional: while UNSET the unguessable per-shop
  // URL path token is the authenticator (see webhooks.acuity.ts). The MOMENT a
  // key is set, every inbound webhook must carry a valid X-Acuity-Signature or
  // it's rejected - no code change needed to harden, just set the env var.
  ACUITY_WEBHOOK_SIGNING_KEY: z.string().min(1).optional(),

  // Google sign-in (optional - barber auth works with email/password without it).
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: cleanUrl().optional(),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: z.string().min(1),

  // Stripe billing (optional - while absent, billing is disabled and every
  // shop has full access; setting all three flips trial/subscription
  // enforcement on without a code change).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_PRICE_ID: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Stripe Connect (per-barber CUSTOMER payments — distinct from the platform
  // subscription above). Connect uses the same STRIPE_SECRET_KEY but a SEPARATE
  // webhook endpoint/secret. While unset, connectEnabled() is false and the
  // payments feature is dark (CI/tests run without it). STRIPE_PRICE_ID is NOT
  // required for Connect — only the secret key + this connect webhook secret.
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Optional SECOND signing secret for a platform ("Your account") webhook
  // endpoint pointed at the SAME /webhooks/stripe-connect URL. A DESTINATION
  // charge's payment_intent.* events fire on the PLATFORM account (not the
  // connected account), so they arrive via a "Your account" endpoint with its
  // own secret. The connect route tries both secrets when verifying.
  STRIPE_PLATFORM_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Supabase Storage for shop photo uploads (logo / hero / gallery). Optional:
  // while any of these is unset, the upload endpoint returns 503 and the page
  // editor falls back to paste-a-URL, so the app still boots and works without
  // it. SERVICE_ROLE key is server-only (full storage access) - never ship it to
  // the browser. BUCKET must be a PUBLIC bucket so the returned URLs render.
  SUPABASE_URL: cleanUrl().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("shop-media"),

  // Error monitoring (optional).
  SENTRY_DSN: cleanUrl().optional(),

  NUDGE_DEFAULT_BUFFER_DAYS: z.coerce.number().int().nonnegative().default(7),
  NUDGE_DEFAULT_DAILY_CAP: z.coerce.number().int().positive().default(50),

  ENABLE_SCHEDULER: boolish.default("false"),
  DB_RLS_ENFORCE: boolish.default("true"),
  DRY_RUN: boolish.default("true"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DEV_SEED_ACUITY_ACCESS_TOKEN: z.string().optional().default(""),
  DEV_SEED_ACUITY_ACCOUNT_ID: z.string().optional().default(""),
});

export type ApiEnv = z.infer<typeof apiSchema>;

let cachedApiEnv: ApiEnv | undefined;

export function apiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  if (cachedApiEnv) return cachedApiEnv;
  const parsed = apiSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid API environment:\n${issues}`);
  }
  cachedApiEnv = parsed.data;
  return cachedApiEnv;
}

const webSchema = z.object({
  APP_BASE_URL: cleanUrl(),
  API_BASE_URL: cleanUrl(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type WebEnv = z.infer<typeof webSchema>;

export function webEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  const parsed = webSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid web environment:\n${issues}`);
  }
  return parsed.data;
}

/** Test helper: reset the cached api env so a test can re-parse a fresh source. */
export function __resetEnvCacheForTests(): void {
  cachedApiEnv = undefined;
}
