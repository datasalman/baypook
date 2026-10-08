/**
 * BayPook API client.
 *
 * Dependency-free and framework-free: it uses only `fetch`, so the Slimedom website can copy
 * this file and `types.ts` verbatim. Contract: docs/API.md (`/api/v1`).
 *
 *   const api = createBayPookClient({ baseUrl: "https://book.example.com" });
 *   const venues = await api.venues();
 *
 * Every failure is thrown as a `BayPookError`; show `friendlyMessage(err)` to the customer.
 */
import type {
  ApiErrorBody,
  Availability,
  AvailabilityQuery,
  BookingSummary,
  CheckoutRequest,
  CheckoutResponse,
  HoldRequest,
  HoldResponse,
  PayInStoreCheckoutResponse,
  Quote,
  QuoteRequest,
  Service,
  Venue,
  VenuesResponse,
} from "./types";

export type * from "./types";

export type ApiErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "LIMIT"
  | "GONE"
  | "HOLD_EXPIRED"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "NETWORK"
  | "UNKNOWN";

const SERVER_CODES: readonly string[] = ["INVALID", "NOT_FOUND", "LIMIT", "GONE", "HOLD_EXPIRED", "UNAVAILABLE", "RATE_LIMITED"];

export class BayPookError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** For LIMIT: the number allowed (a per-booking limit, or on a hold the places still left). */
  readonly limit?: number;
  /** The server's own `error.message`, when it sent one (customer-readable for LIMIT). */
  readonly serverMessage?: string;

  constructor(code: ApiErrorCode, message: string, status: number, limit?: number, serverMessage?: string) {
    super(message);
    this.name = "BayPookError";
    this.code = code;
    this.status = status;
    if (limit !== undefined) this.limit = limit;
    if (serverMessage) this.serverMessage = serverMessage;
  }
}

export interface BayPookClientOptions {
  /** Origin of the BayPook deployment, e.g. "https://book.example.com". "" means same origin. */
  baseUrl: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface BayPookClient {
  /** The venues only (`GET /venues`). */
  venues(): Promise<Venue[]>;
  /**
   * The whole `GET /venues` payload in one request: the venues and the organisation
   * (terms and privacy links, the condensed waiver, contact details, timezone).
   */
  venuesAndOrganisation(): Promise<VenuesResponse>;
  services(venueSlug: string): Promise<Service[]>;
  availability(venueSlug: string, q: AvailabilityQuery): Promise<Availability>;
  quote(body: QuoteRequest): Promise<Quote>;
  createHold(body: HoldRequest): Promise<HoldResponse>;
  checkout(body: CheckoutRequest): Promise<CheckoutResponse>;
  bookingSummary(token: string): Promise<BookingSummary>;
  /**
   * Gives a hold's places back at once (the customer changed their selection or left).
   * Best effort: never throws. Sent with `keepalive`, so it also works from `pagehide`.
   * Do not call it after a successful checkout redirect: the pending booking owns the hold then.
   */
  releaseHold(id: string): Promise<void>;
}

/** Builds `<baseUrl>/api/v1<path>?<query>`; undefined query values are left out. */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const base = baseUrl.replace(/\/+$/, "");
  let url = `${base}/api/v1${path}`;
  if (query) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    if (parts.length > 0) url += `?${parts.join("&")}`;
  }
  return url;
}

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "INVALID";
    case 404:
      return "NOT_FOUND";
    case 410:
      return "HOLD_EXPIRED";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string";
}

/** Turns a non-2xx response (status + parsed body, or null) into a BayPookError. */
export function errorFromResponse(status: number, body: unknown): BayPookError {
  if (isErrorBody(body)) {
    const { code, message, limit } = body.error;
    const known = SERVER_CODES.includes(code) ? (code as ApiErrorCode) : codeForStatus(status);
    const serverMessage = typeof message === "string" && message.trim() ? message.trim() : undefined;
    return new BayPookError(known, serverMessage ?? `Request failed (${status})`, status, typeof limit === "number" ? limit : undefined, serverMessage);
  }
  return new BayPookError(codeForStatus(status), `Request failed (${status})`, status);
}

export function createBayPookClient(opts: BayPookClientOptions): BayPookClient {
  // Wrapped so the global fetch is never called with a foreign `this` ("Illegal invocation").
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl;

  async function request<T>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, keepalive?: boolean): Promise<T> {
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      };
      if (keepalive) init.keepalive = true;
      res = await doFetch(url, init);
    } catch (err) {
      throw new BayPookError("NETWORK", err instanceof Error ? err.message : "Network request failed", 0);
    }

    let data: unknown = null;
    let parsed = true;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }

    if (!res.ok) throw errorFromResponse(res.status, parsed ? data : null);
    if (!parsed || data === null || typeof data !== "object") {
      throw new BayPookError("UNKNOWN", "The booking system sent an unexpected response", res.status);
    }
    return data as T;
  }

  return {
    async venues() {
      const data = await request<VenuesResponse>("GET", buildUrl(base, "/venues"));
      return data.venues;
    },
    venuesAndOrganisation() {
      return request<VenuesResponse>("GET", buildUrl(base, "/venues"));
    },
    async services(venueSlug) {
      const data = await request<{ services: Service[] }>("GET", buildUrl(base, `/venues/${encodeURIComponent(venueSlug)}/services`));
      return data.services;
    },
    availability(venueSlug, q) {
      return request<Availability>(
        "GET",
        buildUrl(base, `/venues/${encodeURIComponent(venueSlug)}/availability`, {
          service: q.service,
          from: q.from,
          to: q.to,
          extraMinutes: q.extraMinutes ? q.extraMinutes : undefined,
        }),
      );
    },
    async quote(body) {
      const data = await request<{ quote: Quote }>("POST", buildUrl(base, "/quote"), body);
      return data.quote;
    },
    createHold(body) {
      return request<HoldResponse>("POST", buildUrl(base, "/holds"), body);
    },
    checkout(body) {
      return request<CheckoutResponse>("POST", buildUrl(base, "/checkout"), body);
    },
    bookingSummary(token) {
      return request<BookingSummary>("GET", buildUrl(base, `/bookings/${encodeURIComponent(token)}/summary`));
    },
    async releaseHold(id) {
      if (!id) return;
      try {
        await request<{ released: boolean }>("DELETE", buildUrl(base, `/holds/${encodeURIComponent(id)}`), undefined, true);
      } catch {
        // Best effort: an unreleased hold simply lapses on its own.
      }
    },
  };
}

/** Customer-facing wording for any error thrown by the client (or anything else). */
export function friendlyMessage(err: unknown): string {
  const code: ApiErrorCode = err instanceof BayPookError ? err.code : "UNKNOWN";
  switch (code) {
    case "GONE":
      return "That time has just gone. Please pick another.";
    case "LIMIT": {
      // The server says which limit it hit ("Only 2 places left at this time.", "Up to 10 places per booking.").
      if (err instanceof BayPookError && err.serverMessage) return err.serverMessage;
      const limit = err instanceof BayPookError ? err.limit : undefined;
      return limit !== undefined
        ? `You can book up to ${limit} places in one go.`
        : "That is more than we can take in one booking. Please choose fewer.";
    }
    case "HOLD_EXPIRED":
      return "Your time ran out, so we let your booking go. Please choose your time again.";
    case "UNAVAILABLE":
      return "Online booking is not available for this venue right now. Message or call us.";
    case "NETWORK":
      return "We could not reach the booking system. Check your connection and try again.";
    case "INVALID":
      return "Something in your booking needs another look. Please check and try again.";
    case "NOT_FOUND":
      return "We could not find that. It may have changed, so please start again.";
    case "RATE_LIMITED":
      return "Lots of people are booking at once. Please wait a moment and try again.";
    default:
      return "Something went wrong on our side. Please try again in a moment.";
  }
}

/** Integer pence to pounds: 1700 → "£17", 1050 → "£10.50", 123400 → "£1,234". */
export function formatPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.round(Math.abs(pence));
  const pounds = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const pennies = abs % 100;
  return pennies === 0 ? `${sign}£${pounds}` : `${sign}£${pounds}.${String(pennies).padStart(2, "0")}`;
}

/** True for the pay-in-store checkout response (no card payment; the booking is already confirmed). */
export function isPayInStoreCheckout(res: CheckoutResponse): res is PayInStoreCheckoutResponse {
  return "thanksUrl" in res;
}
