/**
 * Reports: takings by day and venue, upcoming bookings, no-shows, refunds,
 * money owed, and CSV exports. Every function takes the venue ids the caller
 * may see; the admin page passes `ctx.selectedVenues`.
 *
 * Takings count a payment on the local day it was taken (`payments.createdAt`),
 * whatever happened to it later: a payment that was later refunded still counts
 * as taken, and the refund is subtracted on the day it was given. Imported
 * payments (taken by Wix before the switch) are not BayPook takings and are left
 * out, and so are refunds of them: they are listed with the refunds, marked as a
 * Wix payment, instead.
 */
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { addDays, endOfLocalDay, fmtLocal, localDate, startOfLocalDay } from "@/core/time";
import type { CurrentUser } from "./auth";

// ---------- who sees what ----------

/**
 * Takings, the takings and customers exports, and customer contact details in the
 * bookings export are for an owner, or a manager of every venue in scope
 * (DECISIONS.md 25). Staff see the rest of the reports.
 */
export function canSeeMoneyAndContacts(user: Pick<CurrentUser, "isOwner" | "venues">, venueIds: string[]): boolean {
  if (user.isOwner) return true;
  return venueIds.length > 0 && venueIds.every((id) => user.venues.some((v) => v.venueId === id && v.role === "manager"));
}

// ---------- ranges ----------

export type DateRange = { from: string; to: string };
export type RangePreset = "today" | "week" | "month" | "lastmonth";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "lastmonth", label: "Last month" },
];

export function isRangePreset(v: unknown): v is RangePreset {
  return v === "today" || v === "week" || v === "month" || v === "lastmonth";
}

/** Monday of the week that holds `date` ('YYYY-MM-DD'). */
function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

function lastDayOfMonth(year: number, month1: number): string {
  return new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);
}

/** Inclusive local date range for a preset, relative to `today` ('YYYY-MM-DD'). */
export function presetRange(preset: RangePreset, today: string): DateRange {
  const [y, m] = today.split("-").map(Number);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const from = mondayOf(today);
      return { from, to: addDays(from, 6) };
    }
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: lastDayOfMonth(y, m) };
    case "lastmonth": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${String(pm).padStart(2, "0")}-01`, to: lastDayOfMonth(py, pm) };
    }
  }
}

export type RangeInput = { venueIds: string[]; from: string; to: string; tz: string };

function rangeWindow(r: { from: string; to: string; tz: string }): { start: Date; end: Date } {
  return { start: startOfLocalDay(r.from, r.tz), end: endOfLocalDay(r.to, r.tz) };
}

// ---------- takings ----------

export type TakingsTotals = {
  onlinePence: number;
  cashPence: number;
  cardMachinePence: number;
  /** cash + card machine */
  inStorePence: number;
  refundsPence: number;
  /** online + in store - refunds */
  netPence: number;
};

export type TakingsRow = TakingsTotals & { date: string; venueId: string; venueName: string };

export type TakingsReport = { rows: TakingsRow[]; totals: TakingsTotals };

/** Payment statuses that mean the money was taken at some point. */
const TAKEN_STATUSES: s.Payment["status"][] = ["succeeded", "refunded", "partially_refunded", "disputed"];

function emptyTotals(): TakingsTotals {
  return { onlinePence: 0, cashPence: 0, cardMachinePence: 0, inStorePence: 0, refundsPence: 0, netPence: 0 };
}

/** One row per local day per venue that had any money in or out, oldest first, plus totals. */
export async function takingsByDay(db: DbOrTx, input: RangeInput): Promise<TakingsReport> {
  if (!input.venueIds.length) return { rows: [], totals: emptyTotals() };
  const { start, end } = rangeWindow(input);

  const [venueRows, paymentRows, refundRows] = await Promise.all([
    db.select({ id: s.venues.id, name: s.venues.name }).from(s.venues).where(inArray(s.venues.id, input.venueIds)),
    db
      .select({ venueId: s.payments.venueId, method: s.payments.method, amount: s.payments.amountPence, at: s.payments.createdAt })
      .from(s.payments)
      .where(
        and(
          inArray(s.payments.venueId, input.venueIds),
          inArray(s.payments.status, TAKEN_STATUSES),
          gte(s.payments.createdAt, start),
          lt(s.payments.createdAt, end),
        ),
      ),
    db
      .select({ venueId: s.payments.venueId, amount: s.refunds.amountPence, at: s.refunds.createdAt })
      .from(s.refunds)
      .innerJoin(s.payments, eq(s.refunds.paymentId, s.payments.id))
      .where(
        and(
          inArray(s.payments.venueId, input.venueIds),
          eq(s.refunds.status, "succeeded"),
          // Refunds of money Wix took are not BayPook money out.
          ne(s.payments.method, "imported"),
          gte(s.refunds.createdAt, start),
          lt(s.refunds.createdAt, end),
        ),
      ),
  ]);

  const names = new Map(venueRows.map((v) => [v.id, v.name]));
  const byKey = new Map<string, TakingsRow>();
  const row = (date: string, venueId: string): TakingsRow => {
    const key = `${date}|${venueId}`;
    let r = byKey.get(key);
    if (!r) {
      r = { date, venueId, venueName: names.get(venueId) ?? "", ...emptyTotals() };
      byKey.set(key, r);
    }
    return r;
  };

  for (const p of paymentRows) {
    const r = row(localDate(p.at, input.tz), p.venueId);
    if (p.method === "online_card") r.onlinePence += p.amount;
    else if (p.method === "cash") r.cashPence += p.amount;
    else if (p.method === "card_machine") r.cardMachinePence += p.amount;
  }
  for (const f of refundRows) row(localDate(f.at, input.tz), f.venueId).refundsPence += f.amount;

  const venueOrder = new Map(input.venueIds.map((id, i) => [id, i]));
  const rows = [...byKey.values()]
    .map((r) => {
      const inStorePence = r.cashPence + r.cardMachinePence;
      return { ...r, inStorePence, netPence: r.onlinePence + inStorePence - r.refundsPence };
    })
    .filter((r) => r.onlinePence || r.inStorePence || r.refundsPence)
    .sort((a, b) => a.date.localeCompare(b.date) || (venueOrder.get(a.venueId) ?? 0) - (venueOrder.get(b.venueId) ?? 0));

  const totals = emptyTotals();
  for (const r of rows) {
    totals.onlinePence += r.onlinePence;
    totals.cashPence += r.cashPence;
    totals.cardMachinePence += r.cardMachinePence;
    totals.inStorePence += r.inStorePence;
    totals.refundsPence += r.refundsPence;
    totals.netPence += r.netPence;
  }
  return { rows, totals };
}

// ---------- upcoming ----------

export type UpcomingService = { serviceId: string; serviceName: string; count: number; places: number; valuePence: number };
export type UpcomingVenue = {
  venueId: string;
  venueName: string;
  count: number;
  places: number;
  valuePence: number;
  services: UpcomingService[];
};

/** Confirmed bookings starting in the next `days` days (default 14), per venue and per service. */
export async function upcomingSummary(
  db: DbOrTx,
  input: { venueIds: string[]; now?: Date; days?: number },
): Promise<UpcomingVenue[]> {
  if (!input.venueIds.length) return [];
  const now = input.now ?? new Date();
  const until = new Date(now.getTime() + (input.days ?? 14) * 86_400_000);
  const rows = await db
    .select({
      venueId: s.bookings.venueId,
      venueName: s.venues.name,
      serviceId: s.bookings.serviceId,
      serviceName: s.services.name,
      serviceSort: s.services.sortOrder,
      count: sql<number>`count(*)`,
      places: sql<number>`coalesce(sum(${s.bookings.places}), 0)`,
      value: sql<number>`coalesce(sum(${s.bookings.totalPence}), 0)`,
    })
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.bookings.venueId, s.venues.id))
    .innerJoin(s.services, eq(s.bookings.serviceId, s.services.id))
    .where(
      and(
        inArray(s.bookings.venueId, input.venueIds),
        eq(s.bookings.status, "confirmed"),
        gte(s.bookings.startsAt, now),
        lt(s.bookings.startsAt, until),
      ),
    )
    .groupBy(s.bookings.venueId, s.venues.name, s.bookings.serviceId, s.services.name, s.services.sortOrder)
    .orderBy(asc(s.services.sortOrder), asc(s.services.name));

  const out = new Map<string, UpcomingVenue>();
  for (const id of input.venueIds) {
    const name = rows.find((r) => r.venueId === id)?.venueName;
    if (name) out.set(id, { venueId: id, venueName: name, count: 0, places: 0, valuePence: 0, services: [] });
  }
  for (const r of rows) {
    const v = out.get(r.venueId);
    if (!v) continue;
    const svc = {
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      count: Number(r.count),
      places: Number(r.places),
      valuePence: Number(r.value),
    };
    v.services.push(svc);
    v.count += svc.count;
    v.places += svc.places;
    v.valuePence += svc.valuePence;
  }
  return [...out.values()];
}

// ---------- no-shows, refunds, outstanding ----------

export type BookingListItem = {
  id: string;
  reference: string;
  venueId: string;
  venueName: string;
  serviceName: string;
  startsAt: Date;
  customerName: string;
  places: number;
  totalPence: number;
  paidPence: number;
};

const bookingListColumns = {
  id: s.bookings.id,
  reference: s.bookings.reference,
  venueId: s.bookings.venueId,
  venueName: s.venues.name,
  serviceName: s.services.name,
  startsAt: s.bookings.startsAt,
  firstName: s.customers.firstName,
  lastName: s.customers.lastName,
  places: s.bookings.places,
  totalPence: s.bookings.totalPence,
  paidPence: s.bookings.paidPence,
};

type BookingListRaw = { firstName: string; lastName: string } & Omit<BookingListItem, "customerName">;

function toListItem(r: BookingListRaw): BookingListItem {
  const { firstName, lastName, ...rest } = r;
  return { ...rest, customerName: `${firstName} ${lastName}`.trim() };
}

/** Bookings marked no-show that started in the range, oldest first. */
export async function noShows(db: DbOrTx, input: RangeInput): Promise<BookingListItem[]> {
  if (!input.venueIds.length) return [];
  const { start, end } = rangeWindow(input);
  const rows = await db
    .select(bookingListColumns)
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.bookings.venueId, s.venues.id))
    .innerJoin(s.services, eq(s.bookings.serviceId, s.services.id))
    .innerJoin(s.customers, eq(s.bookings.customerId, s.customers.id))
    .where(
      and(
        inArray(s.bookings.venueId, input.venueIds),
        eq(s.bookings.status, "no_show"),
        gte(s.bookings.startsAt, start),
        lt(s.bookings.startsAt, end),
      ),
    )
    .orderBy(asc(s.bookings.startsAt));
  return rows.map(toListItem);
}

export type RefundListItem = {
  id: string;
  createdAt: Date;
  bookingId: string;
  reference: string;
  venueId: string;
  venueName: string;
  amountPence: number;
  reason: string;
  status: s.Refund["status"];
  byName: string;
  /** The refunded payment was taken by Wix (imported): it does not count in takings. */
  wixPayment: boolean;
};

/** Refunds given in the range (any status), newest first. */
export async function refundsInRange(db: DbOrTx, input: RangeInput): Promise<RefundListItem[]> {
  if (!input.venueIds.length) return [];
  const { start, end } = rangeWindow(input);
  const rows = await db
    .select({
      id: s.refunds.id,
      createdAt: s.refunds.createdAt,
      bookingId: s.refunds.bookingId,
      reference: s.bookings.reference,
      venueId: s.bookings.venueId,
      venueName: s.venues.name,
      amountPence: s.refunds.amountPence,
      reason: s.refunds.reason,
      status: s.refunds.status,
      userName: s.users.name,
      userEmail: s.users.email,
      method: s.payments.method,
    })
    .from(s.refunds)
    .innerJoin(s.payments, eq(s.refunds.paymentId, s.payments.id))
    .innerJoin(s.bookings, eq(s.refunds.bookingId, s.bookings.id))
    .innerJoin(s.venues, eq(s.bookings.venueId, s.venues.id))
    .leftJoin(s.users, eq(s.refunds.createdBy, s.users.id))
    .where(and(inArray(s.bookings.venueId, input.venueIds), gte(s.refunds.createdAt, start), lt(s.refunds.createdAt, end)))
    .orderBy(desc(s.refunds.createdAt));
  return rows.map(({ userName, userEmail, method, ...r }) => ({
    ...r,
    byName: userName || userEmail || "Stripe or system",
    wixPayment: method === "imported",
  }));
}

export type OutstandingItem = BookingListItem & { owedPence: number };

/**
 * Bookings still owed, any date, soonest first. Owed means `total - paid > 0`
 * (DECISIONS.md 29): refunds do not make a booking owe again. Pending online
 * bookings (not paid yet) and cancelled ones are left out.
 */
export async function outstanding(db: DbOrTx, input: { venueIds: string[] }): Promise<OutstandingItem[]> {
  if (!input.venueIds.length) return [];
  const rows = await db
    .select(bookingListColumns)
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.bookings.venueId, s.venues.id))
    .innerJoin(s.services, eq(s.bookings.serviceId, s.services.id))
    .innerJoin(s.customers, eq(s.bookings.customerId, s.customers.id))
    .where(
      and(
        inArray(s.bookings.venueId, input.venueIds),
        sql`${s.bookings.totalPence} - ${s.bookings.paidPence} > 0`,
        inArray(s.bookings.status, ["confirmed", "no_show"]),
      ),
    )
    .orderBy(asc(s.bookings.startsAt));
  return rows.map((r) => {
    const item = toListItem(r);
    return { ...item, owedPence: Math.max(0, item.totalPence - item.paidPence) };
  });
}

// ---------- CSV ----------

/** Byte order mark so Excel opens the file as UTF-8. */
export const CSV_BOM = "﻿";

/**
 * Neutralise spreadsheet formulas: a text cell that starts with = + - @ or a
 * control character is prefixed with an apostrophe (Excel hides it). Plain
 * numbers such as "-5" or "12.50" are left alone.
 */
export function csvSafe(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value)) return `'${value}`;
  return value;
}

function csvField(value: string): string {
  const v = csvSafe(value);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180: CRLF line ends, fields with commas, quotes or line breaks quoted, quotes doubled. No BOM. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const pounds = (pence: number): string => (pence / 100).toFixed(2);

const METHOD_LABEL: Record<s.Booking["paymentMethod"], string> = {
  online_card: "Online card",
  card_machine: "Card machine",
  cash: "Cash",
  pay_in_store: "Pay in store",
  imported: "Imported",
  none: "None",
};

export function linesSummary(b: Pick<s.Booking, "lines" | "addOns">): string {
  return [...b.lines.map((l) => `${l.qty} x ${l.name}`), ...b.addOns.map((a) => `${a.qty} x ${a.name}`)].join("; ");
}

export type ExportInput = { venueIds: string[]; tz: string; from?: string | null; to?: string | null };

/**
 * Every booking (optionally only those starting in from..to), with a header row.
 * `includeContact: false` (staff) leaves out the customer's email and phone columns.
 */
export async function bookingsCsv(db: DbOrTx, input: ExportInput & { includeContact: boolean }): Promise<string[][]> {
  const contact = input.includeContact;
  const header = [
    "Reference",
    "Venue",
    "Service",
    "Start",
    "End",
    "Status",
    "Customer name",
    ...(contact ? ["Email", "Phone"] : []),
    "Places",
    "Lines",
    "Total (GBP)",
    "Paid (GBP)",
    "Refunded (GBP)",
    "Payment method",
    "Source",
    "Created",
  ];
  if (!input.venueIds.length) return [header];
  const where = [inArray(s.bookings.venueId, input.venueIds)];
  if (input.from) where.push(gte(s.bookings.startsAt, startOfLocalDay(input.from, input.tz)));
  if (input.to) where.push(lt(s.bookings.startsAt, endOfLocalDay(input.to, input.tz)));
  const rows = await db
    .select({ b: s.bookings, venueName: s.venues.name, serviceName: s.services.name, c: s.customers })
    .from(s.bookings)
    .innerJoin(s.venues, eq(s.bookings.venueId, s.venues.id))
    .innerJoin(s.services, eq(s.bookings.serviceId, s.services.id))
    .innerJoin(s.customers, eq(s.bookings.customerId, s.customers.id))
    .where(and(...where))
    .orderBy(asc(s.bookings.startsAt), asc(s.bookings.reference));
  const when = (d: Date) => fmtLocal(d, "yyyy-MM-dd HH:mm", input.tz);
  return [
    header,
    ...rows.map(({ b, venueName, serviceName, c }) => [
      b.reference,
      venueName,
      serviceName,
      when(b.startsAt),
      when(b.endsAt),
      b.status,
      `${c.firstName} ${c.lastName}`.trim(),
      ...(contact ? [c.email, c.phone ?? ""] : []),
      String(b.places),
      linesSummary(b),
      pounds(b.totalPence),
      pounds(b.paidPence),
      pounds(b.refundedPence),
      METHOD_LABEL[b.paymentMethod],
      b.source,
      when(b.createdAt),
    ]),
  ];
}

/**
 * Customers with their booking count and last booking in the given venues.
 * With `allCustomers` (the owner exporting every venue) customers without any
 * booking are included too.
 */
export async function customersCsv(db: DbOrTx, input: ExportInput & { allCustomers?: boolean }): Promise<string[][]> {
  const header = ["Name", "Email", "Phone", "Bookings", "Last booking"];
  if (!input.venueIds.length && !input.allCustomers) return [header];
  const stats = input.venueIds.length
    ? await db
        .select({
          customerId: s.bookings.customerId,
          count: sql<number>`count(*)`,
          last: sql<Date | string | null>`max(${s.bookings.startsAt})`,
        })
        .from(s.bookings)
        .where(inArray(s.bookings.venueId, input.venueIds))
        .groupBy(s.bookings.customerId)
    : [];
  const byId = new Map(stats.map((r) => [r.customerId, r]));
  const customers = input.allCustomers
    ? await db.select().from(s.customers).orderBy(asc(s.customers.lastName), asc(s.customers.firstName))
    : byId.size
      ? await db
          .select()
          .from(s.customers)
          .where(inArray(s.customers.id, [...byId.keys()]))
          .orderBy(asc(s.customers.lastName), asc(s.customers.firstName))
      : [];
  return [
    header,
    ...customers.map((c) => {
      const st = byId.get(c.id);
      const last = st?.last ? new Date(st.last) : null;
      return [
        `${c.firstName} ${c.lastName}`.trim(),
        c.email,
        c.phone ?? "",
        String(Number(st?.count ?? 0)),
        last ? fmtLocal(last, "yyyy-MM-dd HH:mm", input.tz) : "",
      ];
    }),
  ];
}

/** The takings report as CSV rows (with a totals row). */
export function takingsCsvRows(report: TakingsReport): string[][] {
  const header = ["Date", "Venue", "Online card (GBP)", "Cash (GBP)", "Card machine (GBP)", "In store (GBP)", "Refunds (GBP)", "Net (GBP)"];
  const line = (date: string, venue: string, r: TakingsTotals) => [
    date,
    venue,
    pounds(r.onlinePence),
    pounds(r.cashPence),
    pounds(r.cardMachinePence),
    pounds(r.inStorePence),
    pounds(r.refundsPence),
    pounds(r.netPence),
  ];
  return [header, ...report.rows.map((r) => line(r.date, r.venueName, r)), line("Total", "", report.totals)];
}
