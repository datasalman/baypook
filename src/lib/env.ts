/**
 * Environment access. The only module that reads process.env for configuration.
 * Values are never exposed; the Connections page only asks `has*` questions.
 */

export type Mode = "demo" | "live";

export function mode(): Mode {
  return process.env.BAYPOOK_MODE === "demo" ? "demo" : "live";
}

export function isDemo(): boolean {
  return mode() === "demo";
}

/** `south-woodford` -> `SOUTH_WOODFORD` (env var names cannot contain hyphens). */
export function envSuffixForSlug(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const env = {
  databaseUrl: () => read("DATABASE_URL"),
  appSecret: (): string => {
    const v = read("APP_SECRET");
    if (v) return v;
    if (isDemo()) return "demo-secret-not-for-production-use-0000000000";
    throw new Error("APP_SECRET is required in live mode");
  },
  baseUrl: (): string => read("BAYPOOK_URL") ?? `http://localhost:${read("PORT") ?? "3000"}`,
  websiteUrl: (): string | undefined => read("WEBSITE_URL"),
  allowedOrigins: (): string[] => {
    const list = (read("ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const defaults = ["http://localhost:3000", "http://localhost:3100"];
    return Array.from(new Set([...defaults, ...list]));
  },
  stripeSecretKey: (slug: string) => read(`STRIPE_SECRET_KEY__${envSuffixForSlug(slug)}`),
  stripeWebhookSecret: (slug: string) => read(`STRIPE_WEBHOOK_SECRET__${envSuffixForSlug(slug)}`),
  resendApiKey: () => read("RESEND_API_KEY"),
  emailFrom: () => read("EMAIL_FROM"),
  ownerAlertEmail: () => read("OWNER_ALERT_EMAIL"),
  googleServiceAccountJson: (): string | undefined => {
    const raw = read("GOOGLE_SERVICE_ACCOUNT_JSON");
    if (raw) return raw;
    const b64 = read("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
    return b64 ? Buffer.from(b64, "base64").toString("utf8") : undefined;
  },
  cronSecret: () => read("CRON_SECRET"),
  demoDir: () => read("BAYPOOK_DEMO_DIR") ?? ".data/demo",
};

/** Stripe key kind, for the Connections page. */
export function stripeKeyKind(key: string | undefined): "live" | "test" | "missing" | "unknown" {
  if (!key) return "missing";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return "unknown";
}
