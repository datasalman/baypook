/**
 * Provider resolution. Reads env presence, never logs values.
 *
 * Demo mode: every provider is the demo adapter.
 * Live mode: a provider with its keys present is real; otherwise it falls back
 * to the demo adapter and `fallback: true` is reported so the admin can show a
 * warning banner. Payments are the exception: a venue without a Stripe key
 * cannot be booked online in live mode (the API says UNAVAILABLE).
 */
import { env, isDemo, stripeKeyKind } from "@/lib/env";
import type { CalendarProvider, ConnectionStatus, EmailProvider, PaymentProvider } from "./types";
import { DemoPaymentProvider } from "./payment/demo";
import { DemoEmailProvider } from "./email/demo";
import { DemoCalendarProvider } from "./calendar/demo";

export type Resolved<T> = { provider: T; fallback: boolean; reason?: string };

const demoPayment = new DemoPaymentProvider();
const demoEmail = new DemoEmailProvider();
const demoCalendar = new DemoCalendarProvider();

const stripeCache = new Map<string, PaymentProvider>();

export async function getPaymentProvider(venueSlug: string): Promise<Resolved<PaymentProvider> | null> {
  if (isDemo()) return { provider: demoPayment, fallback: false };
  const key = env.stripeSecretKey(venueSlug);
  if (!key) return null; // live without a key: online booking unavailable for this venue
  let p = stripeCache.get(venueSlug);
  if (!p) {
    const { StripePaymentProvider } = await import("./payment/stripe");
    p = new StripePaymentProvider(key);
    stripeCache.set(venueSlug, p);
  }
  return { provider: p, fallback: false };
}

let resend: EmailProvider | null = null;

export function emailConfigured(): { ok: boolean; reason?: string } {
  const key = env.resendApiKey();
  const from = env.emailFrom();
  if (!key) return { ok: false, reason: "RESEND_API_KEY is not set" };
  if (!from) return { ok: false, reason: "EMAIL_FROM is not set" };
  return { ok: true };
}

export async function getEmailProvider(): Promise<Resolved<EmailProvider>> {
  if (isDemo()) return { provider: demoEmail, fallback: false };
  const cfg = emailConfigured();
  if (!cfg.ok) return { provider: demoEmail, fallback: true, reason: cfg.reason };
  if (!resend) {
    const { ResendEmailProvider } = await import("./email/resend");
    resend = new ResendEmailProvider(env.resendApiKey()!, env.emailFrom()!);
  }
  return { provider: resend, fallback: false };
}

let google: CalendarProvider | null = null;

export async function getCalendarProvider(): Promise<Resolved<CalendarProvider>> {
  if (isDemo()) return { provider: demoCalendar, fallback: false };
  const json = env.googleServiceAccountJson();
  if (!json) return { provider: demoCalendar, fallback: true, reason: "GOOGLE_SERVICE_ACCOUNT_JSON is not set" };
  if (!google) {
    const { GoogleCalendarProvider } = await import("./calendar/google");
    google = new GoogleCalendarProvider(json);
  }
  return { provider: google, fallback: false };
}

/** Status rows for the Connections page. Pass the venues (slug + calendar id). */
export function connectionStatuses(venues: { slug: string; name: string; googleCalendarId: string | null }[]): ConnectionStatus[] {
  const demo = isDemo();
  const rows: ConnectionStatus[] = [];

  rows.push({
    key: "database",
    label: "Database",
    state: demo ? "demo" : env.databaseUrl() ? "connected" : "missing",
    detail: demo ? "Embedded demo database under .data/demo" : env.databaseUrl() ? "DATABASE_URL is set" : "DATABASE_URL is not set",
    setupStep: "SETUP.md step 4: database",
  });

  for (const v of venues) {
    const kind = stripeKeyKind(env.stripeSecretKey(v.slug));
    const webhook = Boolean(env.stripeWebhookSecret(v.slug));
    let state: ConnectionStatus["state"] = "missing";
    let detail = `Set STRIPE_SECRET_KEY__${v.slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")} and the webhook secret`;
    if (demo) {
      state = "demo";
      detail = "Fake checkout page; no card is charged";
    } else if (kind !== "missing") {
      state = webhook ? "connected" : "fallback";
      detail = webhook
        ? `Stripe ${kind} key and webhook secret present`
        : `Stripe ${kind} key present but the webhook secret is missing: payments will not confirm`;
    }
    rows.push({ key: `stripe:${v.slug}`, label: `Stripe (${v.name})`, state, detail, setupStep: "SETUP.md step 1: Stripe" });
  }

  const email = emailConfigured();
  rows.push({
    key: "email",
    label: "Email (Resend)",
    state: demo ? "demo" : !email.ok ? "fallback" : "connected",
    detail: demo ? "Emails go to the Outbox only" : !email.ok ? `${email.reason}: emails are written to the Outbox but not sent` : `Sending as ${env.emailFrom()}`,
    setupStep: "SETUP.md step 2: Resend",
  });

  const hasGoogle = Boolean(env.googleServiceAccountJson());
  const calendarsMissing = venues.filter((v) => !v.googleCalendarId).map((v) => v.name);
  rows.push({
    key: "calendar",
    label: "Google Calendar",
    state: demo ? "demo" : !hasGoogle ? "fallback" : calendarsMissing.length ? "fallback" : "connected",
    detail: demo
      ? "Events are written to the Calendar log only"
      : !hasGoogle
        ? "GOOGLE_SERVICE_ACCOUNT_JSON is not set: events are logged but not pushed"
        : calendarsMissing.length
          ? `No calendar ID set for ${calendarsMissing.join(", ")} (Settings, Venues)`
          : "Service account present and every venue has a calendar ID",
    setupStep: "SETUP.md step 3: Google Calendar",
  });

  rows.push({
    key: "cron",
    label: "Scheduled jobs",
    state: demo ? "demo" : env.cronSecret() ? "connected" : "missing",
    detail: demo ? "Run jobs from the Jobs page" : env.cronSecret() ? "CRON_SECRET is set; Vercel Cron calls /api/cron/*" : "CRON_SECRET is not set: cron routes refuse to run",
    setupStep: "SETUP.md step 5: Vercel",
  });

  rows.push({
    key: "appSecret",
    label: "App secret",
    state: demo ? "demo" : process.env.APP_SECRET ? "connected" : "missing",
    detail: demo ? "Demo secret" : process.env.APP_SECRET ? "APP_SECRET is set" : "APP_SECRET is required for sign-in",
    setupStep: "SETUP.md step 5: Vercel",
  });

  return rows;
}
