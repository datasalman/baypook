import type { CreateCheckoutInput, CreateCheckoutResult, PaymentProvider, RefundInput, RefundResult } from "../types";
import { env } from "@/lib/env";

/**
 * Demo payments: the checkout URL is BayPook's own fake checkout page, which
 * offers "Pay" and "Decline". Paying calls the same confirmation path the Stripe
 * webhook uses, so the booking code never knows the difference.
 */
export class DemoPaymentProvider implements PaymentProvider {
  readonly name = "demo" as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const checkoutId = `demo_cs_${input.bookingId}`;
    const url = `${env.baseUrl()}/demo/checkout/${encodeURIComponent(input.bookingId)}`;
    return { provider: "demo", checkoutId, url };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { providerRefundId: `demo_re_${input.idempotencyKey.slice(0, 24)}`, status: "succeeded" };
  }

  async expireCheckout(): Promise<void> {
    // nothing to tell
  }
}
