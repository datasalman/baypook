/**
 * Stripe webhook, one endpoint per venue (each venue has its own Stripe account
 * and webhook secret). Verifies the signature against the raw body, then hands
 * the event to `handleStripeEvent`, which is idempotent.
 */
import { getDb } from "@/db";
import { env, isDemo } from "@/lib/env";
import { json } from "@/lib/api";
import { getPaymentProvider } from "@/providers";
import { getVenueBySlug } from "@/server/org";
import { handleStripeEvent } from "@/server/webhooks";
import type { StripePaymentProvider } from "@/providers/payment/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ venue: string }> };

function err(status: number, message: string): Response {
  return json({ error: { code: status === 400 ? "INVALID" : status === 404 ? "NOT_FOUND" : "UNAVAILABLE", message } }, { status });
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { venue: slug } = await ctx.params;
  if (isDemo()) return err(404, "Webhooks are not used in demo mode.");

  const rawBody = await req.text();
  const db = await getDb();
  const venue = await getVenueBySlug(db, slug);
  if (!venue) return err(404, "Unknown venue.");

  const secret = env.stripeWebhookSecret(slug);
  if (!secret) return err(503, "The webhook secret for this venue is not set.");
  const resolved = await getPaymentProvider(slug);
  if (!resolved || resolved.provider.name !== "stripe") return err(503, "Stripe is not set up for this venue.");
  const stripe = resolved.provider as StripePaymentProvider;

  const signature = req.headers.get("stripe-signature");
  if (!signature) return err(400, "Missing Stripe-Signature header.");
  let event;
  try {
    event = stripe.constructEvent(rawBody, signature, secret);
  } catch (e) {
    console.warn(`[webhook:${slug}] bad signature:`, e instanceof Error ? e.message : e);
    return err(400, "The webhook signature did not verify.");
  }

  try {
    const result = await handleStripeEvent(db, { venue, event });
    console.info(`[webhook:${slug}] ${event.id} ${event.type}`, JSON.stringify(result));
    return json({ received: true, ...result });
  } catch (e) {
    console.error(`[webhook:${slug}] ${event.id} ${event.type} failed:`, e);
    // 500 so Stripe retries later.
    return json({ error: { code: "UNKNOWN", message: "Processing failed; Stripe will retry." } }, { status: 500 });
  }
}
