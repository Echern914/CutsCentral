import type { ApiEnv } from "@chairback/config";

/**
 * Launch preflight: "is this deployment actually configured to serve a paying
 * shop, or is half of it silently dark?"
 *
 * Nearly every integration in this codebase is behind an optional-env seam -
 * billing, Connect, email, push, wallet, Square, the receptionist, per-shop
 * numbers. That is deliberate (CI and dev boot without secrets), but it means a
 * MISSING env var never crashes anything: the feature just quietly does
 * nothing. DRY_RUN is the sharpest example - it DEFAULTS TO TRUE, so a prod box
 * where nobody set it accepts bookings and reports "sent" while no customer
 * ever receives a text.
 *
 * This module turns that invisible state into a list you can read before you
 * hand a shop the keys. It is pure and env-shaped so it can be unit-tested
 * without a live process; the route in adminPortal.ts feeds it the real
 * capability booleans from each subsystem's own `*Enabled()` helper, so this
 * file never re-implements (and can never drift from) those rules.
 *
 * It reports only booleans, counts and non-secret scalars - never a key, token
 * or secret value, even though the endpoint is already admin-gated.
 */

export type PreflightSeverity = "blocker" | "warn" | "info";

export interface PreflightCheck {
  key: string;
  label: string;
  ok: boolean;
  severity: PreflightSeverity;
  /** What is true right now. */
  detail: string;
  /** What breaks while `ok` is false. Omitted when ok. */
  impact?: string;
  /** The env var(s) to set. Omitted when ok. */
  fix?: string;
}

export interface PreflightReport {
  dryRun: boolean;
  blockers: number;
  warnings: number;
  checks: PreflightCheck[];
}

/**
 * The capability booleans, injected rather than imported, so this stays pure.
 * Each maps 1:1 to the subsystem helper of the same name.
 */
export interface PreflightCapabilities {
  billing: boolean;
  connect: boolean;
  email: boolean;
  push: boolean;
  wallet: boolean;
  square: boolean;
  receptionist: boolean;
}

/** Campaign SIDs are a comma-separated ordered list; count the real entries. */
export function countMessagingServices(raw: string | undefined): number {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
}

export function buildPreflight(
  env: ApiEnv,
  caps: PreflightCapabilities,
  /** WEB_PROXY_SECRET lives on both apps and is read via process.env, not ApiEnv. */
  webProxySecret: boolean,
): PreflightReport {
  const campaigns = countMessagingServices(env.TWILIO_MESSAGING_SERVICE_SID);
  const numberCapacity = campaigns * env.TWILIO_CAMPAIGN_NUMBER_CAP;

  const checks: PreflightCheck[] = [
    {
      key: "sends",
      label: "Real sends (DRY_RUN)",
      ok: !env.DRY_RUN,
      severity: "blocker",
      detail: env.DRY_RUN
        ? "DRY_RUN is ON - every SMS, email and push is simulated"
        : "DRY_RUN is off - sends go out for real",
      impact: env.DRY_RUN
        ? "Reminders, nudges, loyalty texts and the receptionist all log 'sent' and reach nobody."
        : undefined,
      fix: env.DRY_RUN ? "Set DRY_RUN=false" : undefined,
    },
    {
      key: "scheduler",
      label: "Background jobs (scheduler)",
      ok: env.ENABLE_SCHEDULER,
      severity: "blocker",
      detail: env.ENABLE_SCHEDULER
        ? "Scheduler enabled on this service"
        : "Scheduler is OFF on this service",
      impact: env.ENABLE_SCHEDULER
        ? undefined
        : "No appointment reminders, no nudge/win-back sweeps, no visit promotion, no Acuity resync. Must be on for exactly one API service.",
      fix: env.ENABLE_SCHEDULER ? undefined : "Set ENABLE_SCHEDULER=true",
    },
    {
      key: "twilio_numbers",
      label: "Per-shop phone numbers",
      ok: campaigns > 0,
      severity: "blocker",
      detail:
        campaigns > 0
          ? `${campaigns} A2P campaign${campaigns === 1 ? "" : "s"} configured - room for ~${numberCapacity} shop numbers`
          : "No messaging service configured - numbers are never purchased",
      impact:
        campaigns > 0
          ? undefined
          : "Premium AI shops never get their own line; they stay on the shared platform number, so inbound texts can't be routed to a specific shop.",
      fix: campaigns > 0 ? undefined : "Set TWILIO_MESSAGING_SERVICE_SID",
    },
    {
      key: "receptionist",
      label: "AI receptionist",
      ok: caps.receptionist,
      severity: "blocker",
      detail: caps.receptionist
        ? `Configured (model ${env.RECEPTIONIST_MODEL})`
        : "No Anthropic key - the receptionist is dark",
      impact: caps.receptionist
        ? undefined
        : "Inbound texts get STOP/START handling only; nothing books by SMS.",
      fix: caps.receptionist ? undefined : "Set ANTHROPIC_API_KEY",
    },
    {
      key: "email",
      label: "Transactional email",
      ok: caps.email,
      severity: "blocker",
      detail: caps.email ? "Resend configured" : "Resend not configured",
      impact: caps.email
        ? undefined
        : "No booking confirmations, no password reset (the link hides itself), no trial reminders.",
      fix: caps.email ? undefined : "Set RESEND_API_KEY and EMAIL_FROM",
    },
    {
      key: "billing",
      label: "Subscription billing",
      ok: caps.billing,
      severity: "warn",
      detail: caps.billing
        ? "Stripe subscriptions live - trials and access are enforced"
        : "Billing disabled - every shop has full access for free",
      impact: caps.billing
        ? undefined
        : "Nobody can be charged and no plan gate applies.",
      fix: caps.billing
        ? undefined
        : "Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET",
    },
    {
      key: "billing_premium_ai",
      label: "Premium AI tier price",
      ok: Boolean(env.STRIPE_PREMIUM_AI_PRICE_ID),
      severity: "warn",
      detail: env.STRIPE_PREMIUM_AI_PRICE_ID
        ? "Premium AI purchasable"
        : "No price configured for the Premium AI tier",
      impact: env.STRIPE_PREMIUM_AI_PRICE_ID
        ? undefined
        : "Upgrading to pro_ai 409s; the receptionist can only be comped by hand.",
      fix: env.STRIPE_PREMIUM_AI_PRICE_ID
        ? undefined
        : "Set STRIPE_PREMIUM_AI_PRICE_ID",
    },
    {
      key: "billing_receptionist_addon",
      label: "Receptionist add-on price",
      ok: Boolean(env.STRIPE_RECEPTIONIST_PRICE_ID),
      severity: "warn",
      detail: env.STRIPE_RECEPTIONIST_PRICE_ID
        ? "Add-on purchasable"
        : "No price configured for the receptionist add-on",
      impact: env.STRIPE_RECEPTIONIST_PRICE_ID
        ? undefined
        : "The $40/mo add-on has no self-serve path.",
      fix: env.STRIPE_RECEPTIONIST_PRICE_ID
        ? undefined
        : "Set STRIPE_RECEPTIONIST_PRICE_ID",
    },
    {
      key: "connect",
      label: "Card payments (Stripe Connect)",
      ok: caps.connect,
      severity: "warn",
      detail: caps.connect
        ? "Connect configured - barbers can onboard and take card payments"
        : "Connect not configured - the payments feature is dark",
      impact: caps.connect
        ? undefined
        : "Shops cannot collect card payments through ChairBack.",
      fix: caps.connect
        ? undefined
        : "Set STRIPE_CONNECT_WEBHOOK_SECRET (and/or STRIPE_PLATFORM_WEBHOOK_SECRET)",
    },
    {
      key: "web_proxy_secret",
      label: "Visitor IP forwarding",
      ok: webProxySecret,
      severity: "warn",
      detail: webProxySecret
        ? "Public traffic is rate-limited per visitor"
        : "Public traffic is rate-limited as ONE shared IP",
      impact: webProxySecret
        ? undefined
        : "Every booking visitor shares one bucket, so a busy evening can 429 the whole booking page at once.",
      fix: webProxySecret
        ? undefined
        : "Set the same WEB_PROXY_SECRET on the API and the web app",
    },
    {
      key: "uploads",
      label: "Photo uploads",
      ok: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      severity: "warn",
      detail:
        env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
          ? `Supabase Storage bucket "${env.SUPABASE_STORAGE_BUCKET}"`
          : "Storage not configured - the upload endpoint 503s",
      impact:
        env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
          ? undefined
          : "Shop logo/hero/gallery must be pasted as external URLs instead of uploaded.",
      fix:
        env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
          ? undefined
          : "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    },
    {
      key: "push",
      label: "Web push",
      ok: caps.push,
      severity: "warn",
      detail: caps.push ? "VAPID configured" : "VAPID keys missing",
      impact: caps.push
        ? undefined
        : "Push reminders fall back to SMS, which costs money per send.",
      fix: caps.push
        ? undefined
        : "Set PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT",
    },
    {
      key: "rls",
      label: "Row-level security",
      ok: env.DB_RLS_ENFORCE,
      severity: "warn",
      detail: env.DB_RLS_ENFORCE
        ? "RLS enforced (second isolation layer active)"
        : "RLS enforcement is OFF",
      impact: env.DB_RLS_ENFORCE
        ? undefined
        : "Tenant isolation rests on application code alone.",
      fix: env.DB_RLS_ENFORCE ? undefined : "Set DB_RLS_ENFORCE=true",
    },
    {
      key: "wallet",
      label: "Apple Wallet passes",
      ok: caps.wallet,
      severity: "info",
      detail: caps.wallet
        ? "Pass signing configured"
        : "Not configured - the Add to Wallet button stays hidden",
    },
    {
      key: "square",
      label: "Square integration",
      ok: caps.square,
      severity: "info",
      detail: caps.square
        ? `Configured (${env.SQUARE_ENV})`
        : "Not configured - the Square connect option is hidden",
    },
    {
      key: "sentry",
      label: "Error monitoring",
      ok: Boolean(env.SENTRY_DSN),
      severity: "info",
      detail: env.SENTRY_DSN ? "Sentry DSN set" : "No Sentry DSN - errors only reach the logs",
    },
  ];

  return {
    dryRun: env.DRY_RUN,
    blockers: checks.filter((c) => !c.ok && c.severity === "blocker").length,
    warnings: checks.filter((c) => !c.ok && c.severity === "warn").length,
    checks,
  };
}
