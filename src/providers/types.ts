/**
 * Provider interfaces. Every provider has a real adapter and a demo adapter;
 * the rest of the app only talks to these types.
 */

// ---------- payment ----------

export type CheckoutLineItem = { name: string; qty: number; unitPence: number };

export type CreateCheckoutInput = {
  venueSlug: string;
  bookingId: string;
  bookingReference: string;
  holdId: string;
  customerEmail: string;
  customerName: string;
  amountPence: number;
  currency: string;
  description: string;
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  /** When the hold lapses; Stripe expires the Checkout Session at the same moment (min 30 min for Stripe). */
  expiresAt: Date;
  metadata: Record<string, string>;
};

export type CreateCheckoutResult = {
  provider: PaymentProviderName;
  checkoutId: string;
  url: string;
};

export type RefundInput = {
  venueSlug: string;
  providerPaymentIntentId: string | null;
  providerChargeId: string | null;
  amountPence: number;
  reason: string;
  idempotencyKey: string;
};

export type RefundResult = {
  providerRefundId: string;
  status: "pending" | "succeeded" | "failed";
};

export type PaymentProviderName = "stripe" | "demo";

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Best-effort: tell the provider the checkout is no longer valid (hold expired). */
  expireCheckout(checkoutId: string): Promise<void>;
}

// ---------- email ----------

export type EmailAttachment = {
  filename: string;
  contentType: string;
  /** UTF-8 text content (ics, csv). */
  content: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Stable id for this message (the notification row id) so a retried send is not delivered twice. */
  idempotencyKey?: string;
};

export type EmailProviderName = "resend" | "demo";

export type EmailSendResult = { status: "sent" | "demo"; providerId: string | null };

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

// ---------- calendar ----------

export type CalendarEventInput = {
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  /** Stable key so repeated creates for one booking do not duplicate. */
  bookingId: string;
};

export type CalendarProviderName = "google" | "demo";

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  createEvent(input: CalendarEventInput): Promise<{ eventId: string }>;
  updateEvent(eventId: string, input: CalendarEventInput): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

// ---------- status for the Connections page ----------

export type ConnectionState = "connected" | "missing" | "demo" | "fallback";

export type ConnectionStatus = {
  key: string;
  label: string;
  state: ConnectionState;
  detail: string;
  /** Pointer into SETUP.md */
  setupStep: string;
};
