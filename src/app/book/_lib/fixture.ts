/**
 * FIXTURE MODE (development only). Open `/book?fixture=1`.
 *
 * An in-memory stand-in for the BayPook API, plugged into the real client as its `fetch`,
 * so the reference booking page can be exercised before (or without) the API routes.
 * Responses follow docs/API.md. Nothing here touches a database, Stripe or email.
 * It is loaded with a dynamic import only when `?fixture=1` is set outside production.
 *
 * Handy switches while testing:
 *   - `&hold=30`             holds last 30 seconds instead of 15 minutes (to see expiry)
 *   - any 14:30 workshop     the hold fails with GONE ("That time has just gone")
 *   - first name "Slow"      the thank-you page never sees "confirmed" (tests the 60 s timeout)
 *   - first name "Cancel"    checkout returns you as if the payment was cancelled
 *   - Decoden Craft Party    allows pay in store (to see the radio)
 *   - weekend workshops      seat 12, so 11 places shows the LIMIT message
 *   - active holds count against places and party times (like the real API), and
 *     `DELETE /holds/:id` gives them back, so going back and changing things shows whether
 *     the page releases its old hold. Each release is logged to the console.
 */
import { zonedDateTime } from "@/core/time";
import type {
  AddOn,
  Availability,
  BookingSummary,
  CheckoutRequest,
  HoldRequest,
  Quote,
  QuoteRequest,
  Service,
  SessionAvailability,
  SlotStart,
  Organisation,
  Venue,
} from "@/client/types";
import { addDays, weekdayMon0 } from "./dates";
import { FIXTURE_TOKEN_PREFIX } from "./useBookingClient";

const TZ = "Europe/London";

export interface FixtureOptions {
  /** Hold length in seconds (default 900). */
  holdSeconds?: number;
  /** Simulated latency in ms (default 250). */
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Catalogue (sample data shaped like the seed)

const VENUES: Venue[] = [
  {
    slug: "south-woodford",
    name: "South Woodford",
    status: "open",
    opensAt: null,
    address: "53A George Lane, South Woodford, London E18 1LN",
    postcode: "E18 1LN",
    mapsUrl: "https://maps.google.com/?q=53A+George+Lane+South+Woodford+London+E18+1LN",
    parkingNotes: "Pay-and-display parking on George Lane; South Woodford station (Central line) is a two-minute walk.",
    transportNotes: null,
    maxPlacesPerBooking: 10,
    onlineBookable: true,
    timezone: TZ,
  },
  {
    slug: "lakeside",
    name: "Lakeside",
    status: "opening",
    opensAt: "2026-10-17T09:00:00.000Z",
    address: "Lakeside Shopping Centre, West Thurrock Way, Grays RM20 2ZP",
    postcode: "RM20 2ZP",
    mapsUrl: "https://maps.google.com/?q=Lakeside+Shopping+Centre+West+Thurrock+Way+Grays+RM20+2ZP",
    parkingNotes: "Free parking at Lakeside Shopping Centre.",
    transportNotes: null,
    maxPlacesPerBooking: 10,
    onlineBookable: true,
    timezone: TZ,
  },
  {
    slug: "sample-closed",
    name: "Sample venue (fixture: not bookable online)",
    status: "closed",
    opensAt: null,
    address: "1 Example Street, London",
    postcode: "E1 1AA",
    mapsUrl: null,
    parkingNotes: null,
    transportNotes: null,
    maxPlacesPerBooking: 10,
    onlineBookable: false,
    timezone: TZ,
  },
];

const ORGANISATION: Organisation = {
  name: "Slimedom (fixture)",
  termsUrl: "https://slimedom.com/terms",
  privacyUrl: "https://slimedom.com/privacy",
  termsVersion: 1,
  waiverVersion: 1,
  waiverText:
    "Fixture waiver. Slime and craft materials can stain clothes and soft furnishings, so please dress for mess.\n\n" +
    "A grown-up stays responsible for each child while they are with us. Tell us about any allergies before the day.",
  contactEmail: "hello@example.com",
  contactPhone: "020 0000 0000",
  whatsappUrl: null,
  timezone: TZ,
};

function servicesFor(venue: string): Service[] {
  const id = (s: string) => `${venue}:${s}`;
  const extraChild = (svc: string, price: number, max: number): AddOn => ({
    id: id(`${svc}:extra-child`),
    name: "Extra child",
    blurb: null,
    pricePence: price,
    kind: "quantity",
    extraMinutes: 0,
    maxQuantity: max,
    perChild: true,
  });
  const foodTime = (svc: string): AddOn => ({
    id: id(`${svc}:food-time`),
    name: "Food time",
    blurb: "Thirty minutes extra for food (bring your own).",
    pricePence: 5000,
    kind: "time",
    extraMinutes: 30,
    maxQuantity: 1,
    perChild: false,
  });
  return [
    {
      id: id("classic-workshops"),
      slug: "classic-workshops",
      kind: "session",
      name: "Classic Workshops",
      blurb: "Make your own slime or decorate a decoden piece. One hour, everything provided, take it home.",
      lengthMinutes: 60,
      colour: "#5bbf3a",
      leadTimeMinutes: 0,
      cutoffMinutes: 60,
      payInStoreEnabled: false,
      inStoreNote: null,
      options: [
        {
          id: id("classic-workshops:slime"),
          name: "Slime Workshop",
          blurb: "Mix, colour and customise your own slime.",
          unitPricePence: 1700,
          includedChildren: null,
          maxPerBooking: null,
          inStoreNote: null,
        },
        {
          id: id("classic-workshops:decoden"),
          name: "Decoden Craft Workshop",
          blurb: "Decorate a phone case, mirror or tray with cream clay and charms.",
          unitPricePence: 1000,
          includedChildren: null,
          maxPerBooking: null,
          inStoreNote: {
            line: "Plus your piece, £3 to £20, bought in store.",
            short: "Decoden pieces are bought in store on the day, £3 to £20 each.",
            menuUrl: "https://slimedom.com/workshops#decoden-menu",
          },
        },
      ],
      addOns: [],
    },
    {
      id: id("slime-party"),
      slug: "slime-party",
      kind: "slot",
      name: "Slime Party",
      blurb: "Ninety minutes of slime-making for the birthday child and friends, led by our team.",
      lengthMinutes: 90,
      slotIntervalMinutes: 30,
      colour: "#7c5cff",
      leadTimeMinutes: 48 * 60,
      cutoffMinutes: 0,
      payInStoreEnabled: false,
      inStoreNote: null,
      options: [
        {
          id: id("slime-party:package"),
          name: "Slime Party package",
          blurb: "Includes 10 children.",
          unitPricePence: 20000,
          includedChildren: 10,
          maxPerBooking: 1,
          inStoreNote: null,
        },
      ],
      addOns: [extraChild("slime-party", 1600, 10), foodTime("slime-party")],
    },
    {
      id: id("decoden-craft-party"),
      slug: "decoden-craft-party",
      kind: "slot",
      name: "Decoden Craft Party",
      blurb: "Ninety minutes of decoden crafting; every child decorates a piece to take home.",
      lengthMinutes: 90,
      slotIntervalMinutes: 30,
      colour: "#ff6fae",
      leadTimeMinutes: 48 * 60,
      cutoffMinutes: 0,
      // Fixture only: switched on so the "Pay now / Pay in store" choice can be seen.
      payInStoreEnabled: true,
      inStoreNote: {
        line: "Sample note: extra charms can be bought in store on the day.",
        short: "Extra charms can be bought in store on the day.",
        menuUrl: null,
      },
      options: [
        {
          id: id("decoden-craft-party:package"),
          name: "Decoden Craft Party package",
          blurb: "Includes 8 children and a piece each.",
          unitPricePence: 25000,
          includedChildren: 8,
          maxPerBooking: 1,
          inStoreNote: null,
        },
      ],
      addOns: [extraChild("decoden-craft-party", 2500, 12), foodTime("decoden-craft-party")],
    },
  ];
}

function findService(serviceIdOrSlug: string): { venue: Venue; service: Service } | null {
  for (const venue of VENUES) {
    for (const service of servicesFor(venue.slug)) {
      if (service.id === serviceIdOrSlug) return { venue, service };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability

/** Small deterministic hash so the sample timetable looks lived-in but stays stable. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

function firstOpenDate(venue: Venue): string | null {
  return venue.opensAt ? new Date(venue.opensAt).toLocaleDateString("en-CA", { timeZone: TZ }) : null;
}

function sessionTimes(date: string): string[] {
  const wd = weekdayMon0(date);
  if (wd === 0) return []; // closed Mondays
  if (wd >= 5) return ["10:00", "11:30", "13:00", "14:30", "16:00"];
  return ["15:30", "17:00"];
}

function sessionsFor(venue: Venue, service: Service, date: string, now: Date): SessionAvailability[] {
  const opens = firstOpenDate(venue);
  if (opens && date < opens) return [];
  return sessionTimes(date).map((time) => {
    const start = zonedDateTime(date, time, TZ);
    const end = new Date(start.getTime() + service.lengthMinutes * 60_000);
    // Weekend workshops seat 12, so asking for 11 shows the per-booking LIMIT (10).
    const capacity = weekdayMon0(date) >= 5 ? 12 : 10;
    const seed = hash(`${venue.slug}|${date}|${time}`);
    let remaining = seed % (capacity + 1);
    if (seed % 3 === 0) remaining = capacity;
    const id = `sess:${venue.slug}:${date}:${time.replace(":", "")}`;
    remaining = Math.max(0, remaining - heldPlaces(id, now));
    let reason: SessionAvailability["reason"] = null;
    if (end.getTime() <= now.getTime()) reason = "past";
    else if (start.getTime() - now.getTime() < service.cutoffMinutes * 60_000) reason = "cutoff";
    else if (time === "17:00" && weekdayMon0(date) === 2) {
      reason = "blocked";
      remaining = 0;
    } else if (remaining === 0) reason = "full";
    return {
      id,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      capacity,
      remaining,
      bookable: reason === null,
      reason,
    };
  });
}

function slotsFor(venue: Venue, service: Service, date: string, extraMinutes: number, now: Date): SlotStart[] {
  const opens = firstOpenDate(venue);
  if (opens && date < opens) return [];
  const wd = weekdayMon0(date);
  if (wd < 4) return []; // parties Friday to Sunday in the sample
  const closeMinutes = 18 * 60;
  const length = service.lengthMinutes + extraMinutes;
  const step = service.slotIntervalMinutes ?? 30;
  const out: SlotStart[] = [];
  for (let m = 10 * 60; m + length <= closeMinutes; m += step) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const start = zonedDateTime(date, hhmm, TZ);
    if (start.getTime() - now.getTime() < service.leadTimeMinutes * 60_000) continue;
    if (hash(`${venue.slug}|${service.slug}|${date}|${hhmm}`) % 4 === 0) continue; // already booked
    const end = new Date(start.getTime() + length * 60_000);
    if (partyHeld(venue.slug, start, end, now)) continue; // someone (maybe you) is holding the party room
    out.push({ startsAt: start.toISOString(), endsAt: end.toISOString() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quote

class FixtureError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly limit?: number,
  ) {
    super(message);
  }
}

function quoteFor(body: QuoteRequest): { venue: Venue; service: Service; quote: Quote } {
  const found = findService(body.service);
  if (!found || found.venue.slug !== body.venue) throw new FixtureError(404, "NOT_FOUND", "Service not found");
  const { venue, service } = found;
  const lines = (body.lines ?? []).filter((l) => l.qty > 0);
  const addOns = (body.addOns ?? []).filter((a) => a.qty > 0);
  if (lines.length === 0) throw new FixtureError(400, "INVALID", "Choose at least one place");

  const quote: Quote = { lines: [], addOns: [], subtotalPence: 0, totalPence: 0, places: 0, extraMinutes: 0, inStoreNotes: [] };
  let included = 0;
  for (const l of lines) {
    const option = service.options.find((o) => o.id === l.optionId);
    if (!option || !Number.isInteger(l.qty)) throw new FixtureError(400, "INVALID", "Unknown option");
    if (option.maxPerBooking !== null && l.qty > option.maxPerBooking) {
      throw new FixtureError(409, "LIMIT", `${option.name}: up to ${option.maxPerBooking} per booking.`, option.maxPerBooking);
    }
    quote.lines.push({
      optionId: option.id,
      name: option.name,
      qty: l.qty,
      unitPence: option.unitPricePence,
      totalPence: option.unitPricePence * l.qty,
      includedChildren: option.includedChildren,
    });
    if (service.kind === "session") quote.places += l.qty;
    else included += (option.includedChildren ?? 0) * l.qty;
    if (option.inStoreNote) quote.inStoreNotes.push(option.inStoreNote.short);
  }
  let extraChildren = 0;
  for (const a of addOns) {
    const addOn = service.addOns.find((x) => x.id === a.addOnId);
    if (!addOn || !Number.isInteger(a.qty)) throw new FixtureError(400, "INVALID", "Unknown add-on");
    if (addOn.maxQuantity !== null && a.qty > addOn.maxQuantity) {
      throw new FixtureError(409, "LIMIT", `${addOn.name}: up to ${addOn.maxQuantity}.`, addOn.maxQuantity);
    }
    if (addOn.perChild) extraChildren += a.qty;
    if (addOn.kind === "time") quote.extraMinutes += addOn.extraMinutes * a.qty;
    quote.addOns.push({
      addOnId: addOn.id,
      name: addOn.name,
      qty: a.qty,
      unitPence: addOn.pricePence,
      totalPence: addOn.pricePence * a.qty,
      kind: addOn.kind,
      extraMinutes: addOn.extraMinutes,
      perChild: addOn.perChild,
    });
  }
  if (service.kind === "slot") quote.places = included + extraChildren;
  if (service.kind === "session" && quote.places > venue.maxPlacesPerBooking) {
    throw new FixtureError(409, "LIMIT", `Up to ${venue.maxPlacesPerBooking} places per booking.`, venue.maxPlacesPerBooking);
  }
  if (service.inStoreNote) quote.inStoreNotes.push(service.inStoreNote.short);
  quote.subtotalPence = [...quote.lines, ...quote.addOns].reduce((sum, x) => sum + x.totalPence, 0);
  quote.totalPence = quote.subtotalPence;
  return { venue, service, quote };
}

// ---------------------------------------------------------------------------
// Holds and bookings

interface FixtureHold {
  id: string;
  /** Workshops only. */
  sessionId?: string;
  expiresAt: number;
  startsAt: string;
  endsAt: string;
  venue: Venue;
  service: Service;
  quote: Quote;
}

interface StoredBooking {
  summary: BookingSummary;
  createdAt: number;
  neverConfirm: boolean;
}

const holds = new Map<string, FixtureHold>();

function activeHolds(now: Date): FixtureHold[] {
  return [...holds.values()].filter((h) => h.expiresAt > now.getTime());
}

/** Places held (not yet booked) in a workshop session. */
function heldPlaces(sessionId: string, now: Date): number {
  return activeHolds(now)
    .filter((h) => h.sessionId === sessionId)
    .reduce((sum, h) => sum + h.quote.places, 0);
}

/** True when an active party hold at this venue overlaps [start, end) (half-open). */
function partyHeld(venueSlug: string, start: Date, end: Date, now: Date): boolean {
  return activeHolds(now).some(
    (h) =>
      h.service.kind === "slot" &&
      h.venue.slug === venueSlug &&
      start.getTime() < new Date(h.endsAt).getTime() &&
      end.getTime() > new Date(h.startsAt).getTime(),
  );
}
const memoryBookings = new Map<string, string>();
const STORE_PREFIX = "baypook-fixture-booking:";

function saveBooking(token: string, booking: StoredBooking): void {
  const raw = JSON.stringify(booking);
  try {
    window.sessionStorage.setItem(STORE_PREFIX + token, raw);
  } catch {
    memoryBookings.set(token, raw);
  }
}

function loadBooking(token: string): StoredBooking | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORE_PREFIX + token);
  } catch {
    raw = null;
  }
  raw = raw ?? memoryBookings.get(token) ?? null;
  return raw ? (JSON.parse(raw) as StoredBooking) : null;
}

function randomId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function appendQuery(url: string, query: string): string {
  return url + (url.includes("?") ? "&" : "?") + query;
}

// ---------------------------------------------------------------------------
// Router

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function readBody<T>(init: RequestInit | undefined): Promise<T> {
  const raw = typeof init?.body === "string" ? init.body : "";
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new FixtureError(400, "INVALID", "Body must be JSON");
  }
}

function handle(method: string, url: URL, init: RequestInit | undefined, opts: Required<FixtureOptions>): Promise<Response> | Response {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const now = new Date();
  let m: RegExpMatchArray | null;

  if (method === "GET" && path === "/venues") return json(200, { venues: VENUES, organisation: ORGANISATION });

  if (method === "GET" && (m = path.match(/^\/venues\/([^/]+)\/services$/))) {
    const slug = decodeURIComponent(m[1]);
    if (!VENUES.some((v) => v.slug === slug)) throw new FixtureError(404, "NOT_FOUND", "Venue not found");
    return json(200, { services: servicesFor(slug) });
  }

  if (method === "GET" && (m = path.match(/^\/venues\/([^/]+)\/availability$/))) {
    const slug = decodeURIComponent(m[1]);
    const venue = VENUES.find((v) => v.slug === slug);
    if (!venue) throw new FixtureError(404, "NOT_FOUND", "Venue not found");
    const serviceKey = url.searchParams.get("service") ?? "";
    const service = servicesFor(slug).find((s) => s.id === serviceKey || s.slug === serviceKey);
    if (!service) throw new FixtureError(404, "NOT_FOUND", "Service not found");
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      throw new FixtureError(400, "INVALID", "from and to must be dates");
    }
    const extraMinutes = Number(url.searchParams.get("extraMinutes") ?? 0);
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.push(d);
      if (days.length > 62) throw new FixtureError(400, "INVALID", "Window is at most 62 days");
    }
    const body: Availability =
      service.kind === "session"
        ? { kind: "session", days: days.map((date) => ({ date, sessions: sessionsFor(venue, service, date, now) })).filter((d) => d.sessions.length > 0) }
        : { kind: "slot", days: days.map((date) => ({ date, starts: slotsFor(venue, service, date, extraMinutes, now) })).filter((d) => d.starts.length > 0) };
    return json(200, body);
  }

  if (method === "POST" && path === "/quote") {
    return readBody<QuoteRequest>(init).then((body) => json(200, { quote: quoteFor(body).quote }));
  }

  if (method === "POST" && path === "/holds") {
    return readBody<HoldRequest>(init).then((body) => {
      const { venue, service, quote } = quoteFor(body);
      let startsAt: string;
      let endsAt: string;
      if (service.kind === "session") {
        const parts = (body.sessionId ?? "").split(":");
        if (parts.length !== 4) throw new FixtureError(404, "NOT_FOUND", "Session not found");
        const [, , date, hhmm] = parts;
        if (hhmm === "1430") throw new FixtureError(409, "GONE", "Fixture: 14:30 sessions always go just before you hold them");
        const session = sessionsFor(venue, service, date, now).find((s) => s.id === body.sessionId);
        if (!session) throw new FixtureError(404, "NOT_FOUND", "Session not found");
        if (!session.bookable) throw new FixtureError(409, "GONE", "That session is no longer bookable");
        if (session.remaining < quote.places) {
          const n = session.remaining;
          throw new FixtureError(409, "LIMIT", `Only ${n} ${n === 1 ? "place" : "places"} left at this time.`, n);
        }
        startsAt = session.startsAt;
        endsAt = session.endsAt;
      } else {
        if (!body.startsAt) throw new FixtureError(400, "INVALID", "startsAt is required for parties");
        startsAt = body.startsAt;
        endsAt = new Date(new Date(startsAt).getTime() + (service.lengthMinutes + quote.extraMinutes) * 60_000).toISOString();
        if (partyHeld(venue.slug, new Date(startsAt), new Date(endsAt), now)) throw new FixtureError(409, "GONE", "That party time is held");
      }
      const hold: FixtureHold = {
        id: randomId("hold_"),
        sessionId: service.kind === "session" ? body.sessionId : undefined,
        expiresAt: now.getTime() + opts.holdSeconds * 1000,
        startsAt,
        endsAt,
        venue,
        service,
        quote,
      };
      holds.set(hold.id, hold);
      return json(201, { hold: { id: hold.id, expiresAt: new Date(hold.expiresAt).toISOString(), startsAt, endsAt }, quote });
    });
  }

  if (method === "DELETE" && (m = path.match(/^\/holds\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    const had = holds.delete(id);
    console.info(`[BayPook fixture] DELETE /holds/${id}: ${had ? "released" : "nothing to release"}`);
    return json(200, { released: true });
  }

  if (method === "POST" && path === "/checkout") {
    return readBody<CheckoutRequest>(init).then((body) => {
      const hold = holds.get(body.holdId);
      if (!hold) throw new FixtureError(404, "NOT_FOUND", "Hold not found");
      if (hold.expiresAt <= Date.now()) throw new FixtureError(410, "HOLD_EXPIRED", "The hold has expired");
      const c = body.customer;
      if (!c?.firstName || !c.lastName || !c.email || !c.phone) throw new FixtureError(400, "INVALID", "Customer details are required");
      if (!body.accept?.terms || !body.accept?.waiver) throw new FixtureError(400, "INVALID", "Terms and waiver must be accepted");
      if (hold.service.kind === "slot" && !body.birthdayChild) throw new FixtureError(400, "INVALID", "Birthday child is required");
      holds.delete(hold.id);

      const payInStore = Boolean(body.payInStore && hold.service.payInStoreEnabled);
      const token = randomId(FIXTURE_TOKEN_PREFIX);
      const reference = `BP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const bookingId = randomId("booking_");
      const summary: BookingSummary = {
        reference,
        status: payInStore ? "confirmed" : "pending",
        paymentStatus: payInStore ? "owed" : "unpaid",
        venue: {
          slug: hold.venue.slug,
          name: hold.venue.name,
          address: hold.venue.address,
          postcode: hold.venue.postcode,
          mapsUrl: hold.venue.mapsUrl,
          parkingNotes: hold.venue.parkingNotes,
        },
        service: { name: hold.service.name, kind: hold.service.kind },
        startsAt: hold.startsAt,
        endsAt: hold.endsAt,
        lines: hold.quote.lines.map(({ name, qty, unitPence, totalPence }) => ({ name, qty, unitPence, totalPence })),
        addOns: hold.quote.addOns.map(({ name, qty, unitPence, totalPence }) => ({ name, qty, unitPence, totalPence })),
        totalPence: hold.quote.totalPence,
        paidPence: 0,
        customer: { firstName: c.firstName },
        inStoreNote: hold.quote.inStoreNotes.length > 0 ? hold.quote.inStoreNotes.join(" ") : null,
        paymentMethod: payInStore ? "pay_in_store" : "online_card",
        timezone: TZ,
      };
      saveBooking(token, { summary, createdAt: Date.now(), neverConfirm: c.firstName.trim().toLowerCase() === "slow" });

      const base = body.returnUrl ?? `${window.location.origin}/book/thanks`;
      const venueQ = `venue=${encodeURIComponent(hold.venue.slug)}`;
      if (payInStore) {
        return json(200, { bookingId, reference, token, confirmed: true, thanksUrl: appendQuery(base, `paid=0&${venueQ}&booking=${token}`) });
      }
      // A real API sends the customer to Stripe (or the demo checkout page); the fixture skips straight back.
      const checkoutUrl =
        c.firstName.trim().toLowerCase() === "cancel"
          ? appendQuery(base, `cancelled=1&${venueQ}&fixture=1`)
          : appendQuery(base, `paid=1&${venueQ}&booking=${token}`);
      return json(200, { bookingId, reference, checkoutUrl });
    });
  }

  if (method === "GET" && (m = path.match(/^\/bookings\/([^/]+)\/summary$/))) {
    const token = decodeURIComponent(m[1]);
    const stored = loadBooking(token);
    if (!stored) throw new FixtureError(404, "NOT_FOUND", "Booking not found");
    const summary = { ...stored.summary };
    // Pretend the payment webhook lands about five seconds after checkout.
    if (summary.status === "pending" && !stored.neverConfirm && Date.now() - stored.createdAt > 5000) {
      summary.status = "confirmed";
      summary.paymentStatus = "paid";
      summary.paidPence = summary.totalPence;
    }
    return json(200, summary);
  }

  throw new FixtureError(404, "NOT_FOUND", `Fixture has no route for ${method} ${path}`);
}

/** A `fetch` that answers BayPook API calls from the sample data above. */
export function createFixtureFetch(options: FixtureOptions = {}): typeof fetch {
  const opts: Required<FixtureOptions> = { holdSeconds: options.holdSeconds ?? 900, latencyMs: options.latencyMs ?? 250 };
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://fixture.local");
    const method = (init?.method ?? "GET").toUpperCase();
    await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));
    try {
      return await handle(method, url, init, opts);
    } catch (err) {
      if (err instanceof FixtureError) {
        return json(err.status, { error: { code: err.code, message: err.message, ...(err.limit !== undefined ? { limit: err.limit } : {}) } });
      }
      return json(500, { error: { code: "UNKNOWN", message: err instanceof Error ? err.message : "Fixture error" } });
    }
  };
}



