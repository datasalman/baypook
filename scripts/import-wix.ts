/**
 * Import future Wix bookings from a CSV, before switching a venue's /book to BayPook.
 *
 *   npm run import:wix -- path/to/file.csv [--dry-run] [--as owner@example.com]
 *
 * Columns (header names, case-insensitive; extra columns are ignored):
 *   reference, venue, service, start, first_name, last_name, email, phone,
 *   places, paid_total, birthday_child, notes
 * Optional:
 *   places_<option name slug>  split a workshop's places between its options,
 *                              e.g. places_slime-workshop, places_decoden-craft-workshop
 *   add_ons                    party extras by name, separated by ";", e.g. "Food time"
 *                              or "Food time x1; Extra child x2" (extra children are
 *                              otherwise worked out from `places`)
 *
 * - `venue` is the venue's slug or name; `service` the service's name (or slug) at that venue.
 * - `start` is ISO 8601 (with Z or an offset), or local time in the organisation's
 *   timezone as `YYYY-MM-DD HH:mm` or `DD/MM/YYYY HH:mm`.
 * - `places`: workshops, the number of places (all on the first option unless the
 *   places_<option> columns split them); parties, the number of children.
 * - `paid_total` is in pounds ("34", "34.00", "£1,234.50").
 * - `birthday_child`: "Zara" or "Zara, 7" (parties only).
 *
 * Each row becomes a confirmed booking (source `import`, payment method `imported`,
 * a payment row from `paid_total`, `externalRef` = the Wix reference), with notes
 * starting "Wix ref <reference>". No emails are sent; the calendar mirror is
 * updated. Rows whose reference is already on a booking (`externalRef`, or the
 * notes of bookings imported before that column existed) are skipped, so the
 * import can be run again safely.
 * Capacity and room rules apply (a clash fails the row); lead time and cut-off do not.
 *
 * A dry run (`--dry-run`) does everything a real run would inside one database
 * transaction that is rolled back at the end: each row books its places in that
 * transaction, so two rows of the same file that clash are reported exactly as a
 * real run would report them, and nothing is saved (no sessions either). No email
 * or calendar event is sent on a dry run.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ilike } from "drizzle-orm";
import type { DbOrTx } from "../src/db";
import * as s from "../src/db/schema";
import { DEFAULT_TZ, isValidDateStr, isValidTimeStr, localDate, zonedDateTime } from "../src/core/time";
import type { CurrentUser } from "../src/server/auth";
import { listServicesForVenue, type ServiceWithCatalogue } from "../src/server/catalogue";
import { getOrganisation, listVenues } from "../src/server/org";
import { createManualBooking } from "../src/server/bookings";
import { quoteForService } from "../src/server/quote";
import { assertBookable } from "../src/server/availability";
import { ensureSessions } from "../src/server/sessions";
import { findOrCreateCustomer } from "../src/server/customers";

// ---------- CSV ----------

/**
 * A small RFC 4180 parser: commas, double-quoted fields with "" escapes and
 * embedded commas/newlines, CRLF or LF line ends, an optional UTF-8 BOM.
 * Blank lines, and rows whose cells are all blank (",,,"), are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
    field = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      quoted = true;
      field = "";
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

// ---------- rows ----------

export type WixRow = {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  reference: string;
  venue: string;
  service: string;
  start: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  places: number | null;
  /** places_<option slug> columns with a value, keyed by the slug. */
  placesByOption: Record<string, number>;
  paidTotalPence: number | null;
  birthdayChild: { firstName: string; age: number | null } | null;
  notes: string;
  addOns: { name: string; qty: number }[];
};

export type RowProblem = { line: number; reference: string; message: string };

const REQUIRED = ["reference", "venue", "service", "start", "first_name"] as const;

export function slugify(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

/** "34", "34.00", "£1,234.50" → pence. Null for blank; NaN for nonsense. */
export function parsePounds(v: string): number | null {
  const t = v.trim().replace(/^£/, "").replace(/,/g, "").trim();
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function parseCount(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

/** "Zara", "Zara, 7", "Zara (7)", "Zara 7" → name and age. */
export function parseBirthdayChild(v: string): { firstName: string; age: number | null } | null {
  const t = v.trim();
  if (!t) return null;
  const m = /^(.*?)[\s,(]+(\d{1,2})\)?$/.exec(t);
  if (m && m[1].trim()) return { firstName: m[1].trim(), age: Number(m[2]) };
  return { firstName: t, age: null };
}

/** "Food time; Extra child x2" → [{ Food time, 1 }, { Extra child, 2 }]. */
export function parseAddOns(v: string): { name: string; qty: number }[] {
  return v
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(p);
      return m && m[1].trim() ? { name: m[1].trim(), qty: Number(m[2]) } : { name: p, qty: 1 };
    });
}

/**
 * The start as a UTC instant. ISO with Z/offset is taken as is; otherwise the
 * value is local time in `tz` (`YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm[:ss]`, `DD/MM/YYYY HH:mm`).
 */
export function parseStart(v: string, tz: string = DEFAULT_TZ): Date | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let date: string | null = null;
  let time: string | null = null;
  let m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(:\d{2})?$/.exec(t);
  if (m) {
    date = m[1];
    time = `${m[2].padStart(2, "0")}:${m[3]}`;
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(:\d{2})?$/.exec(t);
    if (m) {
      date = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      time = `${m[4].padStart(2, "0")}:${m[5]}`;
    }
  }
  if (!date || !time || !isValidDateStr(date) || !isValidTimeStr(time)) return null;
  return zonedDateTime(date, time, tz);
}

/** Parse the CSV into rows; rows with unreadable values come back as problems. */
export function readWixCsv(text: string): { rows: WixRow[]; problems: RowProblem[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], problems: [{ line: 1, reference: "", message: "The file is empty." }] };
  const headers = table[0].map(normHeader);
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) {
    return { rows: [], problems: [{ line: 1, reference: "", message: `Missing column(s): ${missing.join(", ")}.` }] };
  }
  const rows: WixRow[] = [];
  const problems: RowProblem[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const get = (h: string) => {
      const idx = headers.indexOf(h);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const line = r + 1;
    const reference = get("reference");
    const bad = (message: string) => problems.push({ line, reference, message });
    if (!reference) {
      bad("No reference.");
      continue;
    }
    const places = parseCount(get("places"));
    if (Number.isNaN(places)) {
      bad(`"places" is not a whole number: ${get("places")}`);
      continue;
    }
    const placesByOption: Record<string, number> = {};
    let splitBad = false;
    headers.forEach((h, idx) => {
      if (!h.startsWith("places_")) return;
      const n = parseCount(cells[idx] ?? "");
      if (n === null) return;
      if (Number.isNaN(n)) splitBad = true;
      else placesByOption[slugify(h.slice("places_".length))] = n;
    });
    if (splitBad) {
      bad("A places_<option> column is not a whole number.");
      continue;
    }
    const paid = parsePounds(get("paid_total"));
    if (Number.isNaN(paid)) {
      bad(`"paid_total" is not an amount in pounds: ${get("paid_total")}`);
      continue;
    }
    rows.push({
      line,
      reference,
      venue: get("venue"),
      service: get("service"),
      start: get("start"),
      firstName: get("first_name"),
      lastName: get("last_name"),
      email: get("email"),
      phone: get("phone"),
      places,
      placesByOption,
      paidTotalPence: paid,
      birthdayChild: parseBirthdayChild(get("birthday_child")),
      notes: get("notes"),
      addOns: parseAddOns(get("add_ons")),
    });
  }
  return { rows, problems };
}

// ---------- mapping onto the catalogue ----------

export type CatalogueVenue = { venue: s.Venue; services: ServiceWithCatalogue[] };

export type PlannedBooking = {
  row: WixRow;
  venue: s.Venue;
  service: ServiceWithCatalogue;
  startsAt: Date;
  lines: { optionId: string; qty: number }[];
  addOns: { addOnId: string; qty: number }[];
  customer: { firstName: string; lastName: string; email: string; phone: string | null };
  birthdayChild: { firstName: string; age: number | null } | null;
  notes: string;
  paidPence: number;
};

export class ImportRowError extends Error {}

/** The note every imported booking starts with; also how re-runs recognise it. */
export function wixRefNote(reference: string): string {
  return `Wix ref ${reference}`;
}

/** True when `notes` carries exactly this Wix reference (not a longer one that starts with it). */
export function notesHaveWixRef(notes: string | null | undefined, reference: string): boolean {
  const n = notes ?? "";
  const needle = wixRefNote(reference).toLowerCase();
  let from = 0;
  const lower = n.toLowerCase();
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) return false;
    const next = lower.charAt(at + needle.length);
    if (next === "" || /\s|[.,;)]/.test(next)) return true;
    from = at + 1;
  }
}

/** Map one CSV row onto a venue, service, options and add-ons. Throws ImportRowError. */
export function planRow(row: WixRow, catalogue: CatalogueVenue[], tz: string = DEFAULT_TZ): PlannedBooking {
  const venueKey = row.venue.trim().toLowerCase();
  const entry = catalogue.find((c) => c.venue.slug.toLowerCase() === venueKey || c.venue.name.trim().toLowerCase() === venueKey);
  if (!entry) throw new ImportRowError(`No venue called "${row.venue}".`);
  const { venue } = entry;

  const serviceKey = row.service.trim().toLowerCase();
  const service = entry.services.find((x) => x.name.trim().toLowerCase() === serviceKey || x.slug.toLowerCase() === serviceKey);
  if (!service) throw new ImportRowError(`No service called "${row.service}" at ${venue.name}.`);

  const startsAt = parseStart(row.start, tz);
  if (!startsAt) throw new ImportRowError(`Cannot read the start "${row.start}". Use 2026-10-25 14:00 or ISO 8601.`);
  if (!row.firstName.trim()) throw new ImportRowError("No first name.");
  if (service.options.length === 0) throw new ImportRowError(`${service.name} has no options to book.`);

  const lines: { optionId: string; qty: number }[] = [];
  const addOns: { addOnId: string; qty: number }[] = [];

  for (const a of row.addOns) {
    const addOn = service.addOns.find((x) => x.name.trim().toLowerCase() === a.name.toLowerCase());
    if (!addOn) throw new ImportRowError(`${service.name} has no extra called "${a.name}".`);
    if (a.qty > 0) addOns.push({ addOnId: addOn.id, qty: a.qty });
  }

  if (service.kind === "session") {
    const split = service.options
      .map((o) => ({ optionId: o.id, qty: row.placesByOption[slugify(o.name)] ?? 0 }))
      .filter((l) => l.qty > 0);
    if (split.length) {
      const sum = split.reduce((n, l) => n + l.qty, 0);
      if (row.places !== null && row.places !== sum) {
        throw new ImportRowError(`"places" is ${row.places} but the places_ columns add up to ${sum}.`);
      }
      lines.push(...split);
    } else {
      if (!row.places || row.places < 1) throw new ImportRowError("No places.");
      lines.push({ optionId: service.options[0].id, qty: row.places });
    }
  } else {
    const pkg = service.options[0];
    lines.push({ optionId: pkg.id, qty: 1 });
    const included = pkg.includedChildren ?? 0;
    const children = row.places ?? included;
    const extra = Math.max(0, children - included);
    const perChild = service.addOns.find((a) => a.perChild);
    const already = perChild ? addOns.find((a) => a.addOnId === perChild.id) : undefined;
    if (extra > 0 && !already) {
      if (!perChild) throw new ImportRowError(`${children} children is more than the ${included} included, and ${service.name} has no extra-child option.`);
      addOns.push({ addOnId: perChild.id, qty: extra });
    }
  }

  const email = row.email.trim().toLowerCase();
  return {
    row,
    venue,
    service,
    startsAt,
    lines,
    addOns,
    customer: {
      firstName: row.firstName.trim(),
      lastName: row.lastName.trim(),
      // A booking with no e-mail gets the walk-in placeholder (DECISIONS.md 21): nothing is ever sent to it.
      email: email || `no-email@${venue.slug}.local`,
      phone: row.phone.trim() || null,
    },
    birthdayChild: service.kind === "slot" ? row.birthdayChild : null,
    notes: [wixRefNote(row.reference), row.notes.trim()].filter(Boolean).join("\n"),
    paidPence: row.paidTotalPence ?? 0,
  };
}

// ---------- the import ----------

export type ImportOutcome = {
  line: number;
  reference: string;
  result: "created" | "would create" | "skipped" | "failed";
  message: string;
  bookingReference?: string;
  bookingId?: string;
};

export type ImportOptions = { user: CurrentUser; dryRun?: boolean; now?: Date };

async function loadCatalogue(db: DbOrTx): Promise<CatalogueVenue[]> {
  const venues = await listVenues(db);
  const out: CatalogueVenue[] = [];
  for (const venue of venues) out.push({ venue, services: await listServicesForVenue(db, venue.id) });
  return out;
}

async function existingBookingForRef(db: DbOrTx, reference: string): Promise<s.Booking | null> {
  const [byRef] = await db.select().from(s.bookings).where(eq(s.bookings.externalRef, reference)).limit(1);
  if (byRef) return byRef;
  // Bookings imported before `externalRef` existed carry the reference in their notes only.
  const like = `%${wixRefNote(reference).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select().from(s.bookings).where(ilike(s.bookings.notes, like));
  return rows.find((b) => notesHaveWixRef(b.notes, reference)) ?? null;
}

async function findSessionId(db: DbOrTx, plan: PlannedBooking, tz: string): Promise<string> {
  const day = localDate(plan.startsAt, tz);
  await ensureSessions(db, plan.service, plan.venue, day, day, tz);
  const [session] = await db
    .select({ id: s.sessions.id, status: s.sessions.status })
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, plan.service.id), eq(s.sessions.startsAt, plan.startsAt)))
    .limit(1);
  if (!session) {
    throw new ImportRowError(`There is no ${plan.service.name} session at that time. Add one in Catalogue (an "add" exception), then run the import again.`);
  }
  if (session.status === "cancelled") throw new ImportRowError(`The ${plan.service.name} session at that time is cancelled.`);
  return session.id;
}

/** Thrown to roll the dry run's transaction back once every row has been tried. */
class DryRunRollback extends Error {}

type RunContext = { opts: ImportOptions; now: Date; tz: string; organisationId: string };

/**
 * Import every row. Never throws for a bad row; each row gets an outcome. A dry run
 * runs the same checks inside a transaction that is rolled back, booking each row's
 * places as it goes so clashes within the file are found, and saves nothing.
 */
export async function importWix(db: DbOrTx, csvText: string, opts: ImportOptions): Promise<ImportOutcome[]> {
  const now = opts.now ?? new Date();
  const org = await getOrganisation(db);
  const ctx: RunContext = { opts, now, tz: org.timezone || DEFAULT_TZ, organisationId: org.id };
  const { rows, problems } = readWixCsv(csvText);
  const outcomes: ImportOutcome[] = problems.map((p) => ({ ...p, result: "failed" }));

  if (!opts.dryRun) {
    outcomes.push(...(await importRows(db, rows, ctx)));
  } else {
    try {
      await db.transaction(async (tx) => {
        outcomes.push(...(await importRows(tx, rows, ctx)));
        throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
  }
  return outcomes.sort((a, b) => a.line - b.line);
}

async function importRows(db: DbOrTx, rows: WixRow[], ctx: RunContext): Promise<ImportOutcome[]> {
  const { opts, now, tz } = ctx;
  const outcomes: ImportOutcome[] = [];
  const catalogue = await loadCatalogue(db);
  const seen = new Set<string>();

  for (const row of rows) {
    const out = (result: ImportOutcome["result"], message: string, extra: Partial<ImportOutcome> = {}) =>
      outcomes.push({ line: row.line, reference: row.reference, result, message, ...extra });
    const key = row.reference.toLowerCase();
    if (seen.has(key)) {
      out("skipped", "Same reference earlier in this file.");
      continue;
    }
    seen.add(key);

    try {
      const existing = await existingBookingForRef(db, row.reference);
      if (existing) {
        out("skipped", `Already imported as ${existing.reference}.`, { bookingReference: existing.reference, bookingId: existing.id });
        continue;
      }
      const plan = planRow(row, catalogue, tz);
      if (plan.startsAt.getTime() <= now.getTime()) throw new ImportRowError("That booking has already started; only future bookings are imported.");
      const q = quoteForService(null, { service: plan.service, venue: plan.venue, lines: plan.lines, addOns: plan.addOns });
      const priceNote = plan.paidPence !== q.totalPence ? ` Paid on Wix £${(plan.paidPence / 100).toFixed(2)}; BayPook's price today £${(q.totalPence / 100).toFixed(2)}.` : "";

      if (opts.dryRun) {
        // A savepoint per row: a failed row leaves nothing behind for the rows after it.
        await db.transaction(async (sp) => {
          const sessionId = plan.service.kind === "session" ? await findSessionId(sp, plan, tz) : null;
          await reservePlaces(sp, plan, sessionId, q, ctx);
        });
        out("would create", `${plan.service.name}, ${q.places} ${plan.service.kind === "slot" ? "children" : "places"}.${priceNote}`);
        continue;
      }

      const sessionId = plan.service.kind === "session" ? await findSessionId(db, plan, tz) : null;
      const booking = await createManualBooking(db, {
        user: opts.user,
        venue: plan.venue,
        service: plan.service,
        sessionId,
        startsAt: plan.service.kind === "slot" ? plan.startsAt : null,
        lines: plan.lines,
        addOns: plan.addOns,
        customer: plan.customer,
        birthdayChild: plan.birthdayChild,
        notes: plan.notes,
        payment: { method: "imported", amountPence: plan.paidPence },
        source: "import",
        externalRef: row.reference,
        sendEmail: false,
        now,
      });
      out("created", `${plan.service.name}, ${booking.places} ${plan.service.kind === "slot" ? "children" : "places"}.${priceNote}`, {
        bookingReference: booking.reference,
        bookingId: booking.id,
      });
    } catch (e) {
      out("failed", e instanceof Error ? e.message : String(e));
    }
  }
  return outcomes;
}

/**
 * Dry run only, inside the transaction that is rolled back: the same conflict check
 * as a real booking, then a confirmed booking row holding the places (and the
 * reference), so later rows of the file see them. No email, no calendar event.
 */
async function reservePlaces(
  tx: DbOrTx,
  plan: PlannedBooking,
  sessionId: string | null,
  q: { places: number; extraMinutes: number },
  ctx: RunContext,
): Promise<void> {
  const endsAt = new Date(plan.startsAt.getTime() + (plan.service.lengthMinutes + q.extraMinutes) * 60_000);
  const slot = await assertBookable(tx, {
    venue: plan.venue,
    service: plan.service,
    sessionId,
    startsAt: plan.startsAt,
    endsAt,
    places: q.places,
    now: ctx.now,
    tz: ctx.tz,
    ignoreTiming: true,
  });
  let roomId = plan.service.roomId;
  if (slot.sessionId) {
    const [session] = await tx.select({ roomId: s.sessions.roomId }).from(s.sessions).where(eq(s.sessions.id, slot.sessionId)).limit(1);
    if (session) roomId = session.roomId;
  }
  const customer = await findOrCreateCustomer(tx, { organisationId: ctx.organisationId, ...plan.customer });
  const id = randomUUID();
  await tx.insert(s.bookings).values({
    reference: `DRY-RUN-${id}`,
    venueId: plan.venue.id,
    serviceId: plan.service.id,
    roomId,
    sessionId: slot.sessionId,
    customerId: customer.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    status: "confirmed",
    places: q.places,
    source: "import",
    paymentMethod: "imported",
    externalRef: plan.row.reference,
    token: `dry-run-${id}`,
  });
}

/** Plain-text table of outcomes. */
export function formatOutcomes(outcomes: ImportOutcome[]): string {
  const header = ["Line", "Wix ref", "Result", "BayPook ref", "Details"];
  const body = outcomes.map((o) => [String(o.line), o.reference, o.result, o.bookingReference ?? "", o.message]);
  const widths = header.map((h, i) => Math.min(48, Math.max(h.length, ...body.map((r) => r[i].length))));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  const counts = (["created", "would create", "skipped", "failed"] as const)
    .map((k) => `${outcomes.filter((o) => o.result === k).length} ${k}`)
    .join(", ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt), "", counts].join("\n");
}

// ---------- CLI ----------

async function main(): Promise<void> {
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--as");
  const dryRun = args.includes("--dry-run");
  const asIdx = args.indexOf("--as");
  const asEmail = asIdx >= 0 ? args[asIdx + 1]?.trim().toLowerCase() : undefined;
  if (!file) {
    console.error("Usage: npm run import:wix -- path/to/file.csv [--dry-run] [--as owner@example.com]");
    process.exit(2);
  }
  const fs = await import("node:fs");
  const text = fs.readFileSync(file, "utf8");

  const { getDb } = await import("../src/db");
  const { loadUser } = await import("../src/server/auth");
  const db = await getDb();
  const users = await db.select().from(s.users).where(asEmail ? eq(s.users.email, asEmail) : eq(s.users.isOwner, true));
  const row = users.find((u) => u.active);
  const user = row ? await loadUser(db, row.id) : null;
  if (!user) {
    console.error(asEmail ? `No active user ${asEmail}.` : "No active owner to record the import against. Pass --as <email>.");
    process.exit(2);
  }
  console.log(`${dryRun ? "Checking" : "Importing"} ${file} as ${user.email}${dryRun ? " (dry run: nothing is saved)" : ""}\n`);
  const outcomes = await importWix(db, text, { user, dryRun });
  console.log(formatOutcomes(outcomes));
  process.exit(outcomes.some((o) => o.result === "failed") ? 1 : 0);
}

if (process.argv[1] && /import-wix\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
