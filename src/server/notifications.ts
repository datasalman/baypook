/**
 * Notification service: renders booking emails from the owner-editable templates,
 * records every email in `notifications` (which doubles as the Outbox) and hands
 * it to the email provider. Provider failures never throw; they are recorded.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { DEFAULT_TEMPLATES, type TemplateKey } from "@/providers/email/defaults";
import { renderTemplate, wrapHtml, type Brand } from "@/providers/email/render";
import { buildIcs } from "@/providers/email/ics";
import { getEmailProvider } from "@/providers";
import type { EmailAttachment } from "@/providers/types";
import { env } from "@/lib/env";
import { addDays, fmtDayLong, fmtPence, fmtTime, localDate, localWeekday, zonedDateTime } from "@/core/time";

export type { TemplateKey } from "@/providers/email/defaults";

export type BookingEmailContext = {
  booking: s.Booking;
  customer: s.Customer;
  service: s.Service;
  venue: s.Venue;
  organisation: s.Organisation;
  options?: s.ServiceOption[];
};

export type EmailExtra = { refundAmountPence?: number; adminUrl?: string };

export type RenderedBookingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  venueId: string;
  bookingId: string;
};

// ---------- loading ----------

export async function loadBookingEmailContext(db: DbOrTx, bookingId: string): Promise<BookingEmailContext> {
  const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  if (!booking) throw new Error(`Booking ${bookingId} not found`);
  const [[customer], [service], [venue], options] = await Promise.all([
    db.select().from(s.customers).where(eq(s.customers.id, booking.customerId)).limit(1),
    db.select().from(s.services).where(eq(s.services.id, booking.serviceId)).limit(1),
    db.select().from(s.venues).where(eq(s.venues.id, booking.venueId)).limit(1),
    db.select().from(s.serviceOptions).where(eq(s.serviceOptions.serviceId, booking.serviceId)),
  ]);
  if (!customer || !service || !venue) throw new Error(`Booking ${bookingId} is missing its customer, service or venue`);
  const [organisation] = await db.select().from(s.organisations).where(eq(s.organisations.id, venue.organisationId)).limit(1);
  if (!organisation) throw new Error(`Venue ${venue.id} has no organisation`);
  return { booking, customer, service, venue, organisation, options };
}

// ---------- formatting helpers (shared with the calendar mirror) ----------

/** One plain-text line per booking line and add-on, e.g. "2 × Slime Workshop  £34.00". */
export function formatWhatBooked(booking: Pick<s.Booking, "lines" | "addOns">): string {
  const out: string[] = [];
  for (const l of booking.lines ?? []) {
    if (!l || l.qty <= 0) continue;
    if (l.includedChildren) {
      const name = l.qty === 1 ? l.name : `${l.qty} × ${l.name}`;
      out.push(`${name} (includes ${l.includedChildren} children)  ${fmtPence(l.totalPence)}`);
    } else {
      out.push(`${l.qty} × ${l.name}  ${fmtPence(l.totalPence)}`);
    }
  }
  for (const a of booking.addOns ?? []) {
    if (!a || a.qty <= 0) continue;
    if (a.kind === "time") {
      const extra = a.extraMinutes > 0 ? ` (+${a.extraMinutes} min)` : "";
      const name = a.qty === 1 ? a.name : `${a.qty} × ${a.name}`;
      out.push(`${name}${extra}  ${fmtPence(a.totalPence)}`);
    } else {
      out.push(`${a.qty} × ${a.name}  ${fmtPence(a.totalPence)}`);
    }
  }
  return out.join("\n");
}

export function paymentLineFor(booking: Pick<s.Booking, "paymentMethod" | "paymentStatus">): string {
  switch (booking.paymentMethod) {
    case "online_card":
      return "Paid online";
    case "imported":
      return "Imported";
    case "card_machine":
    case "cash":
    case "pay_in_store":
      return booking.paymentStatus === "paid" || booking.paymentStatus === "partially_refunded" || booking.paymentStatus === "refunded"
        ? "Paid in store"
        : "To pay in store";
    default:
      return booking.paymentStatus === "paid" ? "Paid" : "To pay in store";
  }
}

function joinOr(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

export function contactLineFor(org: Pick<s.Organisation, "contactEmail" | "contactPhone" | "whatsappUrl">): string {
  const parts = [org.contactEmail, org.contactPhone ?? "", org.whatsappUrl ? `WhatsApp ${org.whatsappUrl}` : ""]
    .map((p) => p.trim())
    .filter(Boolean);
  return joinOr(parts);
}

/** In-store notes for the options actually booked, then the service's own note. */
export function inStoreNoteFor(ctx: Pick<BookingEmailContext, "booking" | "service" | "options">): string {
  const notes: string[] = [];
  const push = (note: string | null | undefined, menuUrl: string | null | undefined) => {
    const n = (note ?? "").trim();
    if (!n) return;
    const full = menuUrl ? `${n} See the menu: ${menuUrl}` : n;
    if (!notes.includes(full)) notes.push(full);
  };
  const options = ctx.options ?? [];
  for (const line of ctx.booking.lines ?? []) {
    if (!line || line.qty <= 0) continue;
    const opt = options.find((o) => o.id === line.optionId);
    if (opt) push(opt.inStoreNoteShort ?? opt.inStoreNoteLine, opt.inStoreMenuUrl);
  }
  push(ctx.service.inStoreNoteShort ?? ctx.service.inStoreNoteLine, ctx.service.inStoreMenuUrl);
  return notes.join(" ");
}

export function brandFor(org: s.Organisation): Brand {
  const footerLines = [
    org.legalName ?? org.name,
    org.legalAddress ?? "",
    org.companyNumber ? `Company number ${org.companyNumber.replace(/^company number\s*/i, "")}` : "",
    org.websiteUrl ?? "",
  ];
  return { name: org.name, primary: org.brandPrimary, ink: org.brandInk, footerLines };
}

export function adminBookingUrl(bookingId: string): string {
  return `${env.baseUrl().replace(/\/+$/, "")}/admin/bookings/${bookingId}`;
}

/** Every key in PLACEHOLDERS, as strings. */
export function buildTemplateContext(ctx: BookingEmailContext, extra: EmailExtra = {}): Record<string, string> {
  const { booking, customer, service, venue, organisation: org } = ctx;
  const tz = org.timezone || "Europe/London";
  const refundPence = extra.refundAmountPence ?? (booking.refundedPence > 0 ? booking.refundedPence : 0);
  const birthday = booking.birthdayChildFirstName
    ? `${booking.birthdayChildFirstName}${booking.birthdayChildAge ? `, age ${booking.birthdayChildAge}` : ""}`
    : "";
  return {
    firstName: customer.firstName,
    reference: booking.reference,
    serviceName: service.name,
    venueName: venue.name,
    dayLong: fmtDayLong(booking.startsAt, tz),
    startTime: fmtTime(booking.startsAt, tz),
    endTime: fmtTime(booking.endsAt, tz),
    address: venue.address,
    parkingLine: [venue.parkingNotes, venue.transportNotes]
      .map((x) => (x ?? "").trim())
      .filter(Boolean)
      .join(" "),
    whatBooked: formatWhatBooked(booking),
    total: fmtPence(booking.totalPence),
    inStoreNote: inStoreNoteFor(ctx),
    birthdayChild: birthday,
    contactLine: contactLineFor(org),
    organisationName: org.name,
    refundAmount: refundPence > 0 ? fmtPence(refundPence) : "",
    paymentLine: paymentLineFor(booking),
    customerName: `${customer.firstName} ${customer.lastName}`.trim(),
    customerPhone: customer.phone ?? "",
    customerEmail: customer.email,
    adminUrl: extra.adminUrl ?? adminBookingUrl(booking.id),
  };
}

// ---------- templates ----------

export async function getTemplate(db: DbOrTx, organisationId: string, key: TemplateKey): Promise<{ subject: string; body: string }> {
  const [row] = await db
    .select({ subject: s.emailTemplates.subject, body: s.emailTemplates.body })
    .from(s.emailTemplates)
    .where(and(eq(s.emailTemplates.organisationId, organisationId), eq(s.emailTemplates.key, key)))
    .limit(1);
  if (row && row.body.trim() !== "") return row;
  const def = DEFAULT_TEMPLATES.find((t) => t.key === key);
  if (!def) throw new Error(`Unknown email template ${key}`);
  return { subject: def.subject, body: def.body };
}

function icsFor(ctx: BookingEmailContext, vars: Record<string, string>, method: "PUBLISH" | "CANCEL"): EmailAttachment {
  const { booking, venue, organisation: org, service } = ctx;
  const description = [
    `Reference ${booking.reference}`,
    vars.whatBooked,
    vars.inStoreNote,
    `${venue.name}, ${venue.address}`,
    vars.parkingLine,
    vars.contactLine ? `Need to change it? Message or call us: ${vars.contactLine}` : "",
  ]
    .filter((x) => x && x.trim() !== "")
    .join("\n\n");
  const content = buildIcs({
    uid: `${booking.id}@baypook`,
    summary: `${service.name} at ${org.name} ${venue.name}`,
    description,
    location: [venue.name, venue.address].filter(Boolean).join(", "),
    start: booking.startsAt,
    end: booking.endsAt,
    organiserName: org.name,
    organiserEmail: org.contactEmail,
    url: venue.mapsUrl ?? org.websiteUrl ?? undefined,
    sequence: method === "CANCEL" ? 1 : 0,
    method,
  });
  return {
    filename: `booking-${booking.reference}.ics`,
    contentType: `text/calendar; charset=utf-8; method=${method}`,
    content,
  };
}

export async function renderBookingEmail(
  db: DbOrTx,
  input: { bookingId: string; template: TemplateKey; extra?: EmailExtra },
): Promise<RenderedBookingEmail> {
  const ctx = await loadBookingEmailContext(db, input.bookingId);
  return renderFromContext(db, ctx, input.template, input.extra);
}

async function renderFromContext(
  db: DbOrTx,
  ctx: BookingEmailContext,
  key: TemplateKey,
  extra: EmailExtra = {},
): Promise<RenderedBookingEmail> {
  const { booking, customer, organisation: org } = ctx;
  const vars = buildTemplateContext(ctx, extra);
  const tpl = await getTemplate(db, org.id, key);
  const r = renderTemplate(tpl, vars);
  const html = wrapHtml(r.html, brandFor(org), { title: r.subject });

  const attachments: EmailAttachment[] = [];
  if (key === "confirmation" || key === "reminder") attachments.push(icsFor(ctx, vars, "PUBLISH"));
  if (key === "cancellation") attachments.push(icsFor(ctx, vars, "CANCEL"));

  const to = key === "owner_new_party" ? (env.ownerAlertEmail() ?? org.contactEmail) : customer.email;
  return { to, subject: r.subject, html, text: r.text, attachments, venueId: booking.venueId, bookingId: booking.id };
}

// ---------- sending ----------

type QueuedEmail = {
  bookingId: string | null;
  venueId: string | null;
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  replyTo?: string;
};

async function queueAndSend(db: DbOrTx, email: QueuedEmail): Promise<s.Notification> {
  const [row] = await db
    .insert(s.notifications)
    .values({
      bookingId: email.bookingId,
      venueId: email.venueId,
      channel: "email",
      template: email.template,
      toAddress: email.to,
      subject: email.subject,
      status: "queued",
      bodyHtml: email.html,
      bodyText: email.text,
      attachments: email.attachments,
    })
    .returning();

  let update: Partial<typeof s.notifications.$inferInsert>;
  try {
    const { provider, fallback, reason } = await getEmailProvider();
    const result = await provider.send({
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: email.replyTo,
      attachments: email.attachments,
    });
    update = {
      status: result.status,
      providerId: result.providerId,
      sentAt: new Date(),
      error: fallback ? `Not sent: ${reason ?? "email provider not configured"}` : null,
    };
  } catch (e) {
    update = { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  const [updated] = await db.update(s.notifications).set(update).where(eq(s.notifications.id, row.id)).returning();
  return updated ?? { ...row, ...update };
}

export async function sendBookingEmail(
  db: DbOrTx,
  input: { bookingId: string; template: TemplateKey; to?: string; extra?: EmailExtra; dedupe?: boolean },
): Promise<s.Notification> {
  if (input.dedupe) {
    const [existing] = await db
      .select()
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.bookingId, input.bookingId),
          eq(s.notifications.template, input.template),
          inArray(s.notifications.status, ["sent", "demo"]),
        ),
      )
      .orderBy(asc(s.notifications.createdAt))
      .limit(1);
    if (existing) return existing;
  }

  const ctx = await loadBookingEmailContext(db, input.bookingId);
  const rendered = await renderFromContext(db, ctx, input.template, input.extra);
  return queueAndSend(db, {
    bookingId: rendered.bookingId,
    venueId: rendered.venueId,
    template: input.template,
    to: input.to ?? rendered.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    attachments: rendered.attachments,
    replyTo: input.template === "owner_new_party" ? ctx.customer.email : ctx.organisation.contactEmail,
  });
}

/** Any other email (magic links, invites, tests). Recorded in the Outbox like the rest. */
export async function sendRawEmail(
  db: DbOrTx,
  input: { to: string; subject: string; html: string; text: string; template: string; venueId?: string | null; attachments?: EmailAttachment[] },
): Promise<s.Notification> {
  return queueAndSend(db, {
    bookingId: null,
    venueId: input.venueId ?? null,
    template: input.template,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments ?? [],
  });
}

/**
 * The Outbox, newest first. `venueIds: null/undefined` = every venue (owner);
 * an array limits to those venues (emails without a venue, such as sign-in
 * links, are only visible to the owner).
 */
export async function listOutbox(
  db: DbOrTx,
  opts: { venueIds?: string[] | null; limit?: number; search?: string; bookingId?: string } = {},
): Promise<s.Notification[]> {
  const where: (SQL | undefined)[] = [];
  if (Array.isArray(opts.venueIds)) {
    if (opts.venueIds.length === 0) return [];
    where.push(inArray(s.notifications.venueId, opts.venueIds));
  }
  if (opts.bookingId) where.push(eq(s.notifications.bookingId, opts.bookingId));
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(ilike(s.notifications.toAddress, like), ilike(s.notifications.subject, like), ilike(s.notifications.template, like)),
    );
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db
    .select()
    .from(s.notifications)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.notifications.createdAt))
    .limit(limit);
}

// ---------- preview (Settings) ----------

/**
 * Render a template with a realistic sample booking (no DB booking needed).
 * Uses the organisation's first venue and its real services when they exist.
 */
export async function previewTemplate(
  db: DbOrTx,
  organisationId: string,
  key: TemplateKey,
  override?: { subject: string; body: string },
): Promise<{ subject: string; html: string; text: string }> {
  const [org] = await db.select().from(s.organisations).where(eq(s.organisations.id, organisationId)).limit(1);
  if (!org) throw new Error(`Organisation ${organisationId} not found`);
  const [venue] = await db
    .select()
    .from(s.venues)
    .where(eq(s.venues.organisationId, organisationId))
    .orderBy(asc(s.venues.sortOrder), asc(s.venues.name))
    .limit(1);

  const wantSlot = key === "owner_new_party";
  const services = venue
    ? await db
        .select()
        .from(s.services)
        .where(and(eq(s.services.venueId, venue.id), isNull(s.services.archivedAt)))
        .orderBy(asc(s.services.sortOrder))
    : [];
  const service = services.find((x) => x.kind === (wantSlot ? "slot" : "session")) ?? services[0];
  const options = service
    ? await db
        .select()
        .from(s.serviceOptions)
        .where(and(eq(s.serviceOptions.serviceId, service.id), isNull(s.serviceOptions.archivedAt)))
        .orderBy(asc(s.serviceOptions.sortOrder))
    : [];
  const addOns = service
    ? await db
        .select()
        .from(s.addOns)
        .where(and(eq(s.addOns.serviceId, service.id), isNull(s.addOns.archivedAt)))
        .orderBy(asc(s.addOns.sortOrder))
    : [];

  const ctx = sampleContext(org, venue ?? null, service ?? null, options, addOns);
  const vars = buildTemplateContext(ctx, { refundAmountPence: key === "refund" ? Math.min(1700, ctx.booking.totalPence) : undefined });
  const tpl = override ?? (await getTemplate(db, organisationId, key));
  const r = renderTemplate(tpl, vars);
  return { subject: r.subject, html: wrapHtml(r.html, brandFor(org), { title: r.subject }), text: r.text };
}

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

function sampleContext(
  org: s.Organisation,
  venueRow: s.Venue | null,
  serviceRow: s.Service | null,
  options: s.ServiceOption[],
  addOns: s.AddOn[],
): BookingEmailContext {
  const now = new Date();
  const venue: s.Venue = venueRow ?? {
    id: SAMPLE_ID,
    organisationId: org.id,
    slug: "sample",
    name: "Sample venue",
    status: "open",
    opensAt: null,
    address: "1 Sample Street, London",
    postcode: null,
    mapsUrl: null,
    parkingNotes: "Parking nearby.",
    transportNotes: null,
    googleCalendarId: null,
    openingHours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    openingHoursConfirmed: false,
    maxPlacesPerBooking: 10,
    defaultLeadTimeMinutes: 0,
    defaultCutoffMinutes: 60,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  const service: s.Service = serviceRow ?? {
    id: SAMPLE_ID,
    venueId: venue.id,
    roomId: SAMPLE_ID,
    kind: "session",
    slug: "sample",
    name: "Workshop",
    blurb: null,
    lengthMinutes: 60,
    slotIntervalMinutes: 30,
    sortOrder: 0,
    onlineEnabled: true,
    payInStoreEnabled: false,
    leadTimeMinutes: 0,
    cutoffMinutes: 60,
    inStoreNoteLine: null,
    inStoreNoteShort: null,
    inStoreMenuUrl: null,
    colour: org.brandPrimary,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // A Saturday a couple of weeks out: 14:00 for a workshop, 11:00 for a party, local time.
  const tz = org.timezone || "Europe/London";
  const inTwoWeeks = new Date(now.getTime() + 14 * 86_400_000);
  const saturday = addDays(localDate(inTwoWeeks, tz), (6 - localWeekday(inTwoWeeks, tz) + 7) % 7);
  const start = zonedDateTime(saturday, service.kind === "slot" ? "11:00" : "14:00", tz);

  let lines: s.BookingLine[];
  let bookingAddOns: s.BookingAddOn[] = [];
  let places: number;
  if (service.kind === "slot") {
    const pkg = options[0];
    const unit = pkg?.unitPricePence ?? 20000;
    lines = [
      { optionId: pkg?.id ?? SAMPLE_ID, name: pkg?.name ?? `${service.name} package`, qty: 1, unitPence: unit, totalPence: unit, includedChildren: pkg?.includedChildren ?? 10 },
    ];
    places = (pkg?.includedChildren ?? 10) + 2;
    const extraChild = addOns.find((a) => a.perChild);
    const timeAddOn = addOns.find((a) => a.kind === "time");
    if (extraChild) {
      bookingAddOns.push({ addOnId: extraChild.id, name: extraChild.name, qty: 2, unitPence: extraChild.pricePence, totalPence: 2 * extraChild.pricePence, kind: "quantity", extraMinutes: 0, perChild: true });
    }
    if (timeAddOn) {
      bookingAddOns.push({ addOnId: timeAddOn.id, name: timeAddOn.name, qty: 1, unitPence: timeAddOn.pricePence, totalPence: timeAddOn.pricePence, kind: "time", extraMinutes: timeAddOn.extraMinutes, perChild: false });
    }
  } else {
    const picked = options.length ? options.slice(0, 2) : [];
    lines = picked.length
      ? picked.map((o, i) => {
          const qty = i === 0 ? 2 : 1;
          return { optionId: o.id, name: o.name, qty, unitPence: o.unitPricePence, totalPence: qty * o.unitPricePence };
        })
      : [{ optionId: SAMPLE_ID, name: service.name, qty: 2, unitPence: 1700, totalPence: 3400 }];
    places = lines.reduce((n, l) => n + l.qty, 0);
    bookingAddOns = [];
  }
  const extraMinutes = bookingAddOns.reduce((m, a) => m + (a.kind === "time" ? a.extraMinutes * a.qty : 0), 0);
  const end = new Date(start.getTime() + (service.lengthMinutes + extraMinutes) * 60_000);
  const total = lines.reduce((t, l) => t + l.totalPence, 0) + bookingAddOns.reduce((t, a) => t + a.totalPence, 0);

  const customer: s.Customer = {
    id: SAMPLE_ID,
    organisationId: org.id,
    firstName: "Amina",
    lastName: "Khan",
    email: "amina@example.com",
    phone: "07700 900123",
    notes: null,
    anonymisedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const booking: s.Booking = {
    id: SAMPLE_ID,
    reference: "BP-7K3M2",
    venueId: venue.id,
    serviceId: service.id,
    roomId: service.roomId,
    sessionId: null,
    customerId: customer.id,
    startsAt: start,
    endsAt: end,
    status: "confirmed",
    lines,
    addOns: bookingAddOns,
    places,
    subtotalPence: total,
    totalPence: total,
    paidPence: total,
    refundedPence: 0,
    birthdayChildFirstName: service.kind === "slot" ? "Maya" : null,
    birthdayChildAge: service.kind === "slot" ? 8 : null,
    source: "online",
    paymentMethod: "online_card",
    paymentStatus: "paid",
    termsVersion: org.termsVersion,
    waiverVersion: org.waiverVersion,
    acceptedAt: now,
    token: "sample",
    googleEventId: null,
    notes: null,
    customerMessage: null,
    holdId: null,
    cancelledAt: null,
    cancelReason: null,
    noShowAt: null,
    reminderSentAt: null,
    createdBy: null,
    anonymisedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { booking, customer, service, venue, organisation: org, options };
}
