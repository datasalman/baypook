import Stripe from "stripe";
import type { CreateCheckoutInput, CreateCheckoutResult, PaymentProvider, RefundInput, RefundResult } from "../types";

/** Stripe Checkout (hosted). One instance per venue, each with that venue's secret (or restricted) key. */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { typescript: true });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    // Stripe requires expires_at to be at least 30 minutes ahead and at most 24 hours.
    const minExpiry = Math.floor(Date.now() / 1000) + 31 * 60;
    const expiresAt = Math.max(minExpiry, Math.floor(input.expiresAt.getTime() / 1000));

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        // Immediate card payments only (Apple Pay and Google Pay are card
        // wallets), so a delayed method such as Bacs Direct Debit or Pay by Bank
        // never outlives the hold (DECISIONS 33). API version 2026-09-30.endive
        // replaced `payment_method_types` on Checkout Sessions with this filter.
        allowed_payment_method_types: ["card"],
        customer_email: input.customerEmail,
        client_reference_id: input.bookingReference,
        line_items: input.lineItems.map((li) => ({
          quantity: li.qty,
          price_data: {
            currency: input.currency,
            unit_amount: li.unitPence,
            product_data: { name: li.name },
          },
        })),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: expiresAt,
        metadata: { ...input.metadata, bookingId: input.bookingId, holdId: input.holdId, venueSlug: input.venueSlug },
        payment_intent_data: {
          description: input.description,
          metadata: { bookingId: input.bookingId, bookingReference: input.bookingReference, venueSlug: input.venueSlug },
        },
      },
      { idempotencyKey: `checkout_${input.bookingId}` },
    );
    if (!session.url) throw new Error("Stripe did not return a Checkout URL");
    return { provider: "stripe", checkoutId: session.id, url: session.url };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const params: Stripe.RefundCreateParams = {
      amount: input.amountPence,
      reason: "requested_by_customer",
      metadata: { reason: input.reason.slice(0, 500) },
    };
    if (input.providerPaymentIntentId) params.payment_intent = input.providerPaymentIntentId;
    else if (input.providerChargeId) params.charge = input.providerChargeId;
    else throw new Error("No Stripe payment to refund");
    const refund = await this.stripe.refunds.create(params, { idempotencyKey: input.idempotencyKey });
    const status: RefundResult["status"] =
      refund.status === "succeeded" ? "succeeded" : refund.status === "failed" || refund.status === "canceled" ? "failed" : "pending";
    return { providerRefundId: refund.id, status };
  }

  /**
   * Every refund on a charge, newest first. Webhook events never include the
   * charge's expanded refunds list, so the webhook reconciles from this.
   * 100 is Stripe's page maximum and far more refunds than one booking has.
   */
  async listRefunds(chargeId: string): Promise<Stripe.Refund[]> {
    const page = await this.stripe.refunds.list({ charge: chargeId, limit: 100 });
    return page.data;
  }

  /**
   * Best-effort: Stripe answers an invalid request when the session is already
   * expired or complete, which is fine. Anything else (network, auth, rate
   * limit) is thrown; callers log it and carry on.
   */
  async expireCheckout(checkoutId: string): Promise<void> {
    try {
      await this.stripe.checkout.sessions.expire(checkoutId);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeInvalidRequestError) return;
      throw e;
    }
  }

  /** Verify and parse a webhook payload with this venue's webhook secret. */
  constructEvent(rawBody: string, signature: string, webhookSecret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}
