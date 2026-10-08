/**
 * BayPook public API types (`/api/v1`), mirroring docs/API.md.
 *
 * Standalone: no imports, so the website can copy this file and client.ts verbatim.
 * Money is integer pence. Instants (`startsAt`, `expiresAt`, …) are ISO 8601 UTC strings.
 * Dates are 'YYYY-MM-DD' in the venue's timezone (Europe/London).
 */

export type VenueStatus = "open" | "opening" | "closed";

export interface Venue {
  slug: string;
  name: string;
  status: VenueStatus;
  /** ISO instant the venue opens, for an "opening" venue; otherwise null. */
  opensAt: string | null;
  address: string;
  postcode: string;
  mapsUrl: string | null;
  parkingNotes: string | null;
  transportNotes: string | null;
  maxPlacesPerBooking: number;
  /** False when the venue is closed or cannot take payments online. */
  onlineBookable: boolean;
  timezone: string;
}

/** A note about something paid for in store on the day (e.g. a Decoden piece). */
export interface InStoreNote {
  /** Shown beside the option. */
  line: string;
  /** Shown in summaries and emails. */
  short: string;
  menuUrl: string | null;
}

export interface ServiceOption {
  id: string;
  name: string;
  blurb?: string | null;
  unitPricePence: number;
  /** Slots: children included in the package. Sessions: null. */
  includedChildren: number | null;
  maxPerBooking: number | null;
  inStoreNote: InStoreNote | null;
}

export type AddOnKind = "quantity" | "time";

export interface AddOn {
  id: string;
  name: string;
  blurb?: string | null;
  pricePence: number;
  kind: AddOnKind;
  /** For time add-ons: minutes added to the booking per unit. */
  extraMinutes: number;
  maxQuantity: number | null;
  /** Counts towards the package's child total (e.g. "Extra child"). */
  perChild: boolean;
}

export type ServiceKind = "session" | "slot";

export interface Service {
  id: string;
  slug: string;
  kind: ServiceKind;
  name: string;
  blurb: string | null;
  lengthMinutes: number;
  /** Slots only. */
  slotIntervalMinutes?: number | null;
  colour: string | null;
  leadTimeMinutes: number;
  cutoffMinutes: number;
  payInStoreEnabled: boolean;
  inStoreNote: InStoreNote | null;
  options: ServiceOption[];
  addOns: AddOn[];
}

export type SessionUnavailableReason = "full" | "cutoff" | "lead_time" | "blocked" | "room_busy" | "past" | "cancelled";

export interface SessionAvailability {
  id: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  remaining: number;
  bookable: boolean;
  reason: SessionUnavailableReason | null;
}

export interface SessionAvailabilityDay {
  date: string;
  sessions: SessionAvailability[];
}

export interface SessionAvailabilityResponse {
  kind: "session";
  days: SessionAvailabilityDay[];
}

export interface SlotStart {
  startsAt: string;
  endsAt: string;
}

export interface SlotAvailabilityDay {
  date: string;
  starts: SlotStart[];
}

export interface SlotAvailabilityResponse {
  kind: "slot";
  days: SlotAvailabilityDay[];
}

export type Availability = SessionAvailabilityResponse | SlotAvailabilityResponse;

export interface AvailabilityQuery {
  /** Service id or slug. */
  service: string;
  from: string;
  to: string;
  /** Slots only: total extra minutes from time add-ons being considered. */
  extraMinutes?: number;
}

export interface LineRequest {
  optionId: string;
  qty: number;
}

export interface AddOnRequest {
  addOnId: string;
  qty: number;
}

export interface QuoteRequest {
  venue: string;
  /** Service id. */
  service: string;
  lines: LineRequest[];
  addOns: AddOnRequest[];
}

export interface QuoteLine {
  optionId: string;
  name: string;
  qty: number;
  unitPence: number;
  totalPence: number;
  includedChildren: number | null;
}

export interface QuoteAddOn {
  addOnId: string;
  name: string;
  qty: number;
  unitPence: number;
  totalPence: number;
  kind: AddOnKind;
  extraMinutes: number;
  perChild: boolean;
}

export interface Quote {
  lines: QuoteLine[];
  addOns: QuoteAddOn[];
  subtotalPence: number;
  totalPence: number;
  /** Session places, or total children for a slot (included + extra). */
  places: number;
  extraMinutes: number;
  inStoreNotes: string[];
}

export interface HoldRequest extends QuoteRequest {
  /** Sessions. */
  sessionId?: string;
  /** Slots: ISO instant. */
  startsAt?: string;
}

export interface Hold {
  id: string;
  expiresAt: string;
  startsAt: string;
  endsAt: string;
}

export interface HoldResponse {
  hold: Hold;
  quote: Quote;
}

export interface CheckoutCustomer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface BirthdayChild {
  firstName: string;
  age: number;
}

export interface CheckoutRequest {
  holdId: string;
  customer: CheckoutCustomer;
  /** Parties only. */
  birthdayChild?: BirthdayChild;
  message?: string;
  accept: { terms: boolean; waiver: boolean };
  /** Must be on an allowed origin. Stripe appends ?paid=1&venue=…&booking=… or ?cancelled=1&venue=…. */
  returnUrl?: string;
  /** Only honoured when the service allows it. */
  payInStore?: boolean;
}

export interface OnlineCheckoutResponse {
  bookingId: string;
  reference: string;
  checkoutUrl: string;
}

export interface PayInStoreCheckoutResponse {
  bookingId: string;
  reference: string;
  token: string;
  confirmed: true;
  thanksUrl: string;
}

export type CheckoutResponse = OnlineCheckoutResponse | PayInStoreCheckoutResponse;

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "no_show";
export type PaymentStatus = "unpaid" | "owed" | "paid" | "refunded" | "partially_refunded";
export type PaymentMethod = "online_card" | "card_machine" | "cash" | "pay_in_store" | "imported" | "none";

export interface BookingSummaryItem {
  name: string;
  qty: number;
  unitPence: number;
  totalPence: number;
}

export interface BookingSummary {
  reference: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  venue: {
    slug: string;
    name: string;
    address: string;
    postcode: string;
    mapsUrl: string | null;
    parkingNotes: string | null;
  };
  service: { name: string; kind: ServiceKind };
  startsAt: string;
  endsAt: string;
  lines: BookingSummaryItem[];
  addOns: BookingSummaryItem[];
  totalPence: number;
  paidPence: number;
  customer: { firstName: string };
  /** The contract example only shows null; a string (or note object) is accepted defensively. */
  inStoreNote: string | InStoreNote | null;
  paymentMethod: PaymentMethod;
}

/** Error body for every non-2xx response. */
export interface ApiErrorBody {
  error: { code: string; message: string; limit?: number };
}
