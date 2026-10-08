import { describe, expect, it, vi } from "vitest";
import {
  BayPookError,
  buildUrl,
  createBayPookClient,
  errorFromResponse,
  formatPence,
  friendlyMessage,
  isPayInStoreCheckout,
} from "../../../src/client/client";

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(responses: Array<{ status: number; body?: unknown; raw?: string } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    const text = next.raw ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    return new Response(text, { status: next.status, headers: { "Content-Type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function caught(p: Promise<unknown>): Promise<BayPookError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof BayPookError) return err;
    throw err;
  }
  throw new Error("expected a BayPookError");
}

describe("buildUrl", () => {
  it("joins the base, /api/v1 and the path, trimming trailing slashes", () => {
    expect(buildUrl("https://book.example.com/", "/venues")).toBe("https://book.example.com/api/v1/venues");
    expect(buildUrl("https://book.example.com//", "/venues")).toBe("https://book.example.com/api/v1/venues");
    expect(buildUrl("", "/venues")).toBe("/api/v1/venues");
  });

  it("encodes the query and leaves out undefined values", () => {
    expect(buildUrl("", "/x", { service: "slime party", from: "2026-10-01", extraMinutes: undefined })).toBe(
      "/api/v1/x?service=slime%20party&from=2026-10-01",
    );
    expect(buildUrl("", "/x", {})).toBe("/api/v1/x");
  });
});

describe("createBayPookClient requests", () => {
  it("venues() GETs /venues and unwraps the list", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { venues: [{ slug: "south-woodford" }] } }]);
    const api = createBayPookClient({ baseUrl: "https://bp.test", fetch });
    const venues = await api.venues();
    expect(venues).toEqual([{ slug: "south-woodford" }]);
    expect(calls[0].url).toBe("https://bp.test/api/v1/venues");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("services() encodes the slug and unwraps", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { services: [] } }]);
    const api = createBayPookClient({ baseUrl: "https://bp.test", fetch });
    expect(await api.services("south woodford")).toEqual([]);
    expect(calls[0].url).toBe("https://bp.test/api/v1/venues/south%20woodford/services");
  });

  it("availability() sends service, from, to and extraMinutes only when non-zero", async () => {
    const body = { kind: "slot", days: [] };
    const { fetch, calls } = mockFetch([{ status: 200, body }]);
    const api = createBayPookClient({ baseUrl: "https://bp.test", fetch });
    expect(await api.availability("lakeside", { service: "slime-party", from: "2026-10-01", to: "2026-10-31", extraMinutes: 30 })).toEqual(body);
    await api.availability("lakeside", { service: "slime-party", from: "2026-10-01", to: "2026-10-31", extraMinutes: 0 });
    expect(calls[0].url).toBe(
      "https://bp.test/api/v1/venues/lakeside/availability?service=slime-party&from=2026-10-01&to=2026-10-31&extraMinutes=30",
    );
    expect(calls[1].url).toBe("https://bp.test/api/v1/venues/lakeside/availability?service=slime-party&from=2026-10-01&to=2026-10-31");
  });

  it("quote() POSTs JSON and unwraps the quote", async () => {
    const quote = { lines: [], addOns: [], subtotalPence: 3400, totalPence: 3400, places: 2, extraMinutes: 0, inStoreNotes: [] };
    const { fetch, calls } = mockFetch([{ status: 200, body: { quote } }]);
    const api = createBayPookClient({ baseUrl: "", fetch });
    const req = { venue: "south-woodford", service: "svc", lines: [{ optionId: "o1", qty: 2 }], addOns: [] };
    expect(await api.quote(req)).toEqual(quote);
    expect(calls[0].url).toBe("/api/v1/quote");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(req);
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("createHold(), checkout() and bookingSummary() hit their endpoints and return the body", async () => {
    const hold = { hold: { id: "h1", expiresAt: "x", startsAt: "a", endsAt: "b" }, quote: {} };
    const checkout = { bookingId: "b1", reference: "BP-1", checkoutUrl: "https://checkout.test/1" };
    const summary = { reference: "BP-1", status: "confirmed" };
    const { fetch, calls } = mockFetch([
      { status: 201, body: hold },
      { status: 200, body: checkout },
      { status: 200, body: summary },
    ]);
    const api = createBayPookClient({ baseUrl: "https://bp.test", fetch });
    expect(await api.createHold({ venue: "v", service: "s", sessionId: "x", lines: [], addOns: [] })).toEqual(hold);
    expect(
      await api.checkout({
        holdId: "h1",
        customer: { firstName: "A", lastName: "B", email: "a@example.com", phone: "07700 900123" },
        accept: { terms: true, waiver: true },
      }),
    ).toEqual(checkout);
    expect(await api.bookingSummary("tok/en")).toEqual(summary);
    expect(calls.map((c) => c.url)).toEqual([
      "https://bp.test/api/v1/holds",
      "https://bp.test/api/v1/checkout",
      "https://bp.test/api/v1/bookings/tok%2Fen/summary",
    ]);
  });

  it("releaseHold() DELETEs the hold with keepalive and resolves", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { released: true } }]);
    const api = createBayPookClient({ baseUrl: "https://bp.test", fetch });
    await expect(api.releaseHold("h 1")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://bp.test/api/v1/holds/h%201");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.keepalive).toBe(true);
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("releaseHold() never throws: network failures and error responses are swallowed", async () => {
    const { fetch, calls } = mockFetch([new TypeError("Failed to fetch"), { status: 500, raw: "oops" }]);
    const api = createBayPookClient({ baseUrl: "", fetch });
    await expect(api.releaseHold("h1")).resolves.toBeUndefined();
    await expect(api.releaseHold("h2")).resolves.toBeUndefined();
    await expect(api.releaseHold("")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("error mapping", () => {
  it("maps contract error bodies to codes, keeping status, message and limit", async () => {
    const { fetch } = mockFetch([{ status: 409, body: { error: { code: "LIMIT", message: "Too many places", limit: 10 } } }]);
    const api = createBayPookClient({ baseUrl: "", fetch });
    const err = await caught(api.quote({ venue: "v", service: "s", lines: [{ optionId: "o", qty: 11 }], addOns: [] }));
    expect(err).toBeInstanceOf(BayPookError);
    expect(err.code).toBe("LIMIT");
    expect(err.status).toBe(409);
    expect(err.limit).toBe(10);
    expect(err.message).toBe("Too many places");
    expect(err.serverMessage).toBe("Too many places");
  });

  it("leaves serverMessage unset when the server sent no message", () => {
    const err = errorFromResponse(409, { error: { code: "LIMIT", message: "", limit: 4 } });
    expect(err.serverMessage).toBeUndefined();
    expect(err.message).toBe("Request failed (409)");
    expect(errorFromResponse(500, null).serverMessage).toBeUndefined();
  });

  it.each([
    ["GONE", 409],
    ["HOLD_EXPIRED", 410],
    ["UNAVAILABLE", 503],
    ["RATE_LIMITED", 429],
    ["NOT_FOUND", 404],
    ["INVALID", 400],
  ] as const)("passes through %s", async (code, status) => {
    const { fetch } = mockFetch([{ status, body: { error: { code, message: "m" } } }]);
    const err = await caught(createBayPookClient({ baseUrl: "", fetch }).venues());
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.limit).toBeUndefined();
  });

  it("falls back to the HTTP status when the body is not a contract error", () => {
    expect(errorFromResponse(404, null).code).toBe("NOT_FOUND");
    expect(errorFromResponse(410, "nope").code).toBe("HOLD_EXPIRED");
    expect(errorFromResponse(503, { message: "x" }).code).toBe("UNAVAILABLE");
    expect(errorFromResponse(500, null).code).toBe("UNKNOWN");
    expect(errorFromResponse(409, { error: { code: "WEIRD", message: "x" } }).code).toBe("UNKNOWN");
    expect(errorFromResponse(400, { error: { code: "WEIRD", message: "x" } }).code).toBe("INVALID");
  });

  it("maps a 404 HTML page (route not built yet) to NOT_FOUND", async () => {
    const { fetch } = mockFetch([{ status: 404, raw: "<!doctype html><title>404</title>" }]);
    const err = await caught(createBayPookClient({ baseUrl: "", fetch }).venues());
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  });

  it("maps a thrown fetch to NETWORK with status 0", async () => {
    const { fetch } = mockFetch([new TypeError("Failed to fetch")]);
    const err = await caught(createBayPookClient({ baseUrl: "", fetch }).venues());
    expect(err.code).toBe("NETWORK");
    expect(err.status).toBe(0);
  });

  it("treats a 200 with an unreadable body as UNKNOWN", async () => {
    const { fetch } = mockFetch([{ status: 200, raw: "not json" }]);
    const err = await caught(createBayPookClient({ baseUrl: "", fetch }).venues());
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("friendlyMessage", () => {
  it("uses the agreed customer wording", () => {
    expect(friendlyMessage(new BayPookError("GONE", "x", 409))).toBe("That time has just gone. Please pick another.");
    expect(friendlyMessage(new BayPookError("HOLD_EXPIRED", "x", 410))).toBe(
      "Your 15 minutes ran out, so we released the places. Please choose your time again.",
    );
    expect(friendlyMessage(new BayPookError("UNAVAILABLE", "x", 503))).toBe(
      "Online booking is not available for this venue right now. Message or call us.",
    );
    expect(friendlyMessage(new BayPookError("NETWORK", "x", 0))).toBe(
      "We could not reach the booking system. Check your connection and try again.",
    );
  });

  it("prefers the server's own LIMIT message, falling back to generic wording", () => {
    // On a hold, LIMIT carries the places still left, so the server's message is the accurate one.
    expect(friendlyMessage(errorFromResponse(409, { error: { code: "LIMIT", message: "Only 4 places left at this time.", limit: 4 } }))).toBe(
      "Only 4 places left at this time.",
    );
    expect(friendlyMessage(new BayPookError("LIMIT", "x", 409, 10, "Up to 10 places per booking."))).toBe("Up to 10 places per booking.");
    expect(friendlyMessage(new BayPookError("LIMIT", "x", 409, 10))).toBe("You can book up to 10 places in one go.");
    expect(friendlyMessage(errorFromResponse(409, { error: { code: "LIMIT", message: "", limit: 10 } }))).toBe(
      "You can book up to 10 places in one go.",
    );
  });

  it("only uses the server message for LIMIT", () => {
    expect(friendlyMessage(errorFromResponse(409, { error: { code: "GONE", message: "Session sess_1 is full" } }))).toBe(
      "That time has just gone. Please pick another.",
    );
  });

  it("has a message for every other case, including non-client errors", () => {
    for (const code of ["INVALID", "NOT_FOUND", "RATE_LIMITED", "UNKNOWN"] as const) {
      expect(friendlyMessage(new BayPookError(code, "x", 400)).length).toBeGreaterThan(10);
    }
    expect(friendlyMessage(new BayPookError("LIMIT", "x", 409))).toMatch(/fewer/);
    expect(friendlyMessage(new Error("boom"))).toBe(friendlyMessage(new BayPookError("UNKNOWN", "x", 500)));
    expect(friendlyMessage("oops")).toMatch(/went wrong/);
  });
});

describe("formatPence", () => {
  it("drops .00 and keeps pennies otherwise", () => {
    expect(formatPence(1700)).toBe("£17");
    expect(formatPence(1050)).toBe("£10.50");
    expect(formatPence(5)).toBe("£0.05");
    expect(formatPence(0)).toBe("£0");
    expect(formatPence(123400)).toBe("£1,234");
    expect(formatPence(-250)).toBe("-£2.50");
  });
});

describe("isPayInStoreCheckout", () => {
  it("tells the two checkout responses apart", () => {
    expect(isPayInStoreCheckout({ bookingId: "b", reference: "r", checkoutUrl: "u" })).toBe(false);
    expect(isPayInStoreCheckout({ bookingId: "b", reference: "r", token: "t", confirmed: true, thanksUrl: "u" })).toBe(true);
  });
});
