/**
 * BayPook database schema (Drizzle, PostgreSQL).
 *
 * Written once; runs on real Postgres (live) and PGlite (demo).
 * Rules: money in integer pence; timestamps are `timestamptz` stored in UTC and
 * interpreted in the organisation's timezone (Europe/London) by the core rules.
 * Local-only values (a timetable start time, an exception date) are stored as
 * plain text 'HH:mm' / 'YYYY-MM-DD' so they stay in local time by construction.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- shared column helpers ----------

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------- JSON shapes stored in jsonb columns ----------

export type OpeningHours = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  { open: string; close: string } | null
>;

export type BookingLine = {
  optionId: string;
  name: string;
  qty: number;
  unitPence: number;
  totalPence: number;
  /** For slot packages: how many children the package includes. */
  includedChildren?: number | null;
};

export type BookingAddOn = {
  addOnId: string;
  name: string;
  qty: number;
  unitPence: number;
  totalPence: number;
  kind: "quantity" | "time";
  extraMinutes: number;
  perChild: boolean;
};

export type HoldLine = { optionId: string; qty: number };
export type HoldAddOn = { addOnId: string; qty: number };

// ---------- organisation & venues ----------

export const organisations = pgTable("organisations", {
  id: id(),
  name: text("name").notNull(),
  tagline: text("tagline"),
  legalName: text("legal_name"),
  legalAddress: text("legal_address"),
  companyNumber: text("company_number"),
  contactEmail: text("contact_email").notNull(),
  contactPhone: text("contact_phone"),
  whatsappUrl: text("whatsapp_url"),
  websiteUrl: text("website_url"),
  brandPrimary: text("brand_primary").notNull().default("#5bbf3a"),
  brandInk: text("brand_ink").notNull().default("#1b1f1a"),
  logoUrl: text("logo_url"),
  termsText: text("terms_text").notNull().default(""),
  termsVersion: integer("terms_version").notNull().default(1),
  waiverText: text("waiver_text").notNull().default(""),
  waiverVersion: integer("waiver_version").notNull().default(1),
  termsUrl: text("terms_url"),
  privacyUrl: text("privacy_url"),
  retentionMonths: integer("retention_months").notNull().default(24),
  holdMinutes: integer("hold_minutes").notNull().default(15),
  reminderHoursBefore: integer("reminder_hours_before").notNull().default(24),
  timezone: text("timezone").notNull().default("Europe/London"),
  currency: text("currency").notNull().default("gbp"),
  /** Placeholder flags the owner must confirm, shown in Settings. */
  placeholdersPending: jsonb("placeholders_pending").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const venues = pgTable(
  "venues",
  {
    id: id(),
    organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["open", "opening", "closed"] }).notNull().default("open"),
    opensAt: ts("opens_at"),
    address: text("address").notNull().default(""),
    postcode: text("postcode"),
    mapsUrl: text("maps_url"),
    parkingNotes: text("parking_notes"),
    transportNotes: text("transport_notes"),
    googleCalendarId: text("google_calendar_id"),
    openingHours: jsonb("opening_hours").$type<OpeningHours>().notNull(),
    openingHoursConfirmed: boolean("opening_hours_confirmed").notNull().default(false),
    maxPlacesPerBooking: integer("max_places_per_booking").notNull().default(10),
    defaultLeadTimeMinutes: integer("default_lead_time_minutes").notNull().default(0),
    defaultCutoffMinutes: integer("default_cutoff_minutes").notNull().default(60),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("venues_slug_idx").on(t.slug)],
);

export const rooms = pgTable("rooms", {
  id: id(),
  venueId: uuid("venue_id").notNull().references(() => venues.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

// ---------- catalogue ----------

export const services = pgTable(
  "services",
  {
    id: id(),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    roomId: uuid("room_id").notNull().references(() => rooms.id),
    kind: text("kind", { enum: ["session", "slot"] }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    blurb: text("blurb"),
    lengthMinutes: integer("length_minutes").notNull(),
    /** Slots only: start times every N minutes within opening hours. */
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(30),
    sortOrder: integer("sort_order").notNull().default(0),
    onlineEnabled: boolean("online_enabled").notNull().default(true),
    payInStoreEnabled: boolean("pay_in_store_enabled").notNull().default(false),
    leadTimeMinutes: integer("lead_time_minutes").notNull().default(0),
    cutoffMinutes: integer("cutoff_minutes").notNull().default(60),
    inStoreNoteLine: text("in_store_note_line"),
    inStoreNoteShort: text("in_store_note_short"),
    inStoreMenuUrl: text("in_store_menu_url"),
    colour: text("colour").notNull().default("#5bbf3a"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("services_venue_slug_idx").on(t.venueId, t.slug)],
);

export const serviceOptions = pgTable("service_options", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  name: text("name").notNull(),
  blurb: text("blurb"),
  unitPricePence: integer("unit_price_pence").notNull(),
  /** Slot packages: children included in the price. Null for session options. */
  includedChildren: integer("included_children"),
  maxPerBooking: integer("max_per_booking"),
  inStoreNoteLine: text("in_store_note_line"),
  inStoreNoteShort: text("in_store_note_short"),
  inStoreMenuUrl: text("in_store_menu_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const addOns = pgTable("add_ons", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  name: text("name").notNull(),
  blurb: text("blurb"),
  pricePence: integer("price_pence").notNull(),
  kind: text("kind", { enum: ["quantity", "time"] }).notNull().default("quantity"),
  extraMinutes: integer("extra_minutes").notNull().default(0),
  maxQuantity: integer("max_quantity").notNull().default(1),
  /** Each unit is one extra child beyond the package's included count. */
  perChild: boolean("per_child").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const timetableRules = pgTable("timetable_rules", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  /** 0 = Sunday … 6 = Saturday, in the organisation timezone. */
  weekday: integer("weekday").notNull(),
  /** 'HH:mm' local time. */
  startTime: text("start_time").notNull(),
  capacity: integer("capacity").notNull(),
  /** 'YYYY-MM-DD' local dates, inclusive; null = open-ended. */
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  createdAt: createdAt(),
});

export const timetableExceptions = pgTable("timetable_exceptions", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  /** 'YYYY-MM-DD' local date. */
  date: text("date").notNull(),
  /** 'HH:mm' local; null means the whole day (cancel only). */
  startTime: text("start_time"),
  kind: text("kind", { enum: ["cancel", "add", "capacity"] }).notNull(),
  capacity: integer("capacity"),
  note: text("note"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

/** Materialised session occurrences. Generated on demand for the visible window. */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    roomId: uuid("room_id").notNull().references(() => rooms.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    capacity: integer("capacity").notNull(),
    status: text("status", { enum: ["scheduled", "cancelled"] }).notNull().default("scheduled"),
    source: text("source", { enum: ["rule", "exception", "manual"] }).notNull().default("rule"),
    /** Set when an admin edited this occurrence directly; generation then leaves it alone. */
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sessions_service_start_idx").on(t.serviceId, t.startsAt),
    index("sessions_room_window_idx").on(t.roomId, t.startsAt, t.endsAt),
  ],
);

export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    /** Null = the whole venue. */
    roomId: uuid("room_id").references(() => rooms.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    reason: text("reason").notNull().default(""),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("blocks_venue_window_idx").on(t.venueId, t.startsAt, t.endsAt)],
);

// ---------- holds, customers, bookings ----------

export const holds = pgTable(
  "holds",
  {
    id: id(),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    roomId: uuid("room_id").notNull().references(() => rooms.id),
    sessionId: uuid("session_id").references(() => sessions.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    lines: jsonb("lines").$type<HoldLine[]>().notNull().default([]),
    addOns: jsonb("add_ons").$type<HoldAddOn[]>().notNull().default([]),
    /** Places (sessions) or children (slots) this hold accounts for. */
    places: integer("places").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    status: text("status", { enum: ["active", "converted", "expired", "released"] }).notNull().default("active"),
    checkoutId: text("checkout_id"),
    bookingId: uuid("booking_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("holds_room_window_idx").on(t.roomId, t.startsAt, t.endsAt),
    index("holds_session_idx").on(t.sessionId),
    index("holds_expires_idx").on(t.status, t.expiresAt),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    notes: text("notes"),
    anonymisedAt: ts("anonymised_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customers_email_idx").on(t.organisationId, t.email)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    reference: text("reference").notNull(),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    roomId: uuid("room_id").notNull().references(() => rooms.id),
    sessionId: uuid("session_id").references(() => sessions.id),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    status: text("status", { enum: ["pending", "confirmed", "cancelled", "no_show"] }).notNull(),
    lines: jsonb("lines").$type<BookingLine[]>().notNull().default([]),
    addOns: jsonb("add_ons").$type<BookingAddOn[]>().notNull().default([]),
    /** Session: places; slot: total children (included + extra). */
    places: integer("places").notNull().default(0),
    subtotalPence: integer("subtotal_pence").notNull().default(0),
    totalPence: integer("total_pence").notNull().default(0),
    paidPence: integer("paid_pence").notNull().default(0),
    refundedPence: integer("refunded_pence").notNull().default(0),
    birthdayChildFirstName: text("birthday_child_first_name"),
    birthdayChildAge: integer("birthday_child_age"),
    source: text("source", { enum: ["online", "manual", "import"] }).notNull(),
    paymentMethod: text("payment_method", {
      enum: ["online_card", "card_machine", "cash", "pay_in_store", "imported", "none"],
    }).notNull(),
    paymentStatus: text("payment_status", {
      enum: ["unpaid", "owed", "paid", "refunded", "partially_refunded"],
    })
      .notNull()
      .default("unpaid"),
    termsVersion: integer("terms_version"),
    waiverVersion: integer("waiver_version"),
    acceptedAt: ts("accepted_at"),
    /** Secret token for the thank-you summary and future self-service. */
    token: text("token").notNull(),
    googleEventId: text("google_event_id"),
    /** Internal notes (allergies, anything the parent said). */
    notes: text("notes"),
    /** Message the customer typed when booking. */
    customerMessage: text("customer_message"),
    holdId: uuid("hold_id"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    noShowAt: ts("no_show_at"),
    reminderSentAt: ts("reminder_sent_at"),
    createdBy: uuid("created_by"),
    anonymisedAt: ts("anonymised_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bookings_reference_idx").on(t.reference),
    uniqueIndex("bookings_token_idx").on(t.token),
    index("bookings_venue_start_idx").on(t.venueId, t.startsAt),
    index("bookings_room_window_idx").on(t.roomId, t.startsAt, t.endsAt),
    index("bookings_session_idx").on(t.sessionId),
    index("bookings_customer_idx").on(t.customerId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    bookingId: uuid("booking_id").notNull().references(() => bookings.id),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    provider: text("provider", { enum: ["stripe", "demo", "manual", "import"] }).notNull(),
    providerCheckoutId: text("provider_checkout_id"),
    providerPaymentIntentId: text("provider_payment_intent_id"),
    providerChargeId: text("provider_charge_id"),
    amountPence: integer("amount_pence").notNull(),
    currency: text("currency").notNull().default("gbp"),
    status: text("status", {
      enum: ["pending", "succeeded", "failed", "refunded", "partially_refunded", "disputed"],
    }).notNull(),
    method: text("method", { enum: ["online_card", "card_machine", "cash", "imported"] }).notNull(),
    disputeId: text("dispute_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payments_booking_idx").on(t.bookingId),
    index("payments_checkout_idx").on(t.providerCheckoutId),
    index("payments_intent_idx").on(t.providerPaymentIntentId),
  ],
);

export const refunds = pgTable("refunds", {
  id: id(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  amountPence: integer("amount_pence").notNull(),
  reason: text("reason").notNull().default(""),
  status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull(),
  providerRefundId: text("provider_refund_id"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------- users & auth ----------

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    /** Owners see and do everything at every venue. */
    isOwner: boolean("is_owner").notNull().default(false),
    active: boolean("active").notNull().default(true),
    invitedBy: uuid("invited_by"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const userVenues = pgTable(
  "user_venues",
  {
    userId: uuid("user_id").notNull().references(() => users.id),
    venueId: uuid("venue_id").notNull().references(() => venues.id),
    role: text("role", { enum: ["manager", "staff"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.venueId] })],
);

export const magicLinks = pgTable("magic_links", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const sessionsAuth = pgTable("sessions_auth", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at"),
  createdAt: createdAt(),
});

// ---------- logs & ops ----------

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: uuid("user_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    venueId: uuid("venue_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

/** Every email BayPook sends or would send. Doubles as the demo Outbox. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    bookingId: uuid("booking_id"),
    venueId: uuid("venue_id"),
    channel: text("channel", { enum: ["email"] }).notNull().default("email"),
    template: text("template").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: ["queued", "sent", "failed", "demo"] }).notNull(),
    providerId: text("provider_id"),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull().default(""),
    attachments: jsonb("attachments")
      .$type<{ filename: string; contentType: string; content: string }[]>()
      .notNull()
      .default([]),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_booking_idx").on(t.bookingId, t.template), index("notifications_created_idx").on(t.createdAt)],
);

export const calendarLog = pgTable("calendar_log", {
  id: id(),
  bookingId: uuid("booking_id"),
  venueId: uuid("venue_id"),
  provider: text("provider", { enum: ["google", "demo"] }).notNull(),
  action: text("action", { enum: ["create", "update", "delete"] }).notNull(),
  status: text("status", { enum: ["ok", "failed", "demo"] }).notNull(),
  providerEventId: text("provider_event_id"),
  payload: jsonb("payload"),
  error: text("error"),
  createdAt: createdAt(),
});

export const jobRuns = pgTable("job_runs", {
  id: id(),
  job: text("job").notNull(),
  triggeredBy: text("triggered_by", { enum: ["cron", "admin", "test"] }).notNull(),
  status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
  summary: jsonb("summary"),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: text("id").primaryKey(),
  venueId: uuid("venue_id"),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: updatedAt(),
});

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: id(),
    organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    /** Body in simple Markdown-ish text with {{placeholders}}; rendered to HTML by the email module. */
    body: text("body").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_templates_key_idx").on(t.organisationId, t.key)],
);

// ---------- relations (for db.query.*) ----------

export const organisationsRelations = relations(organisations, ({ many }) => ({
  venues: many(venues),
}));

export const venuesRelations = relations(venues, ({ one, many }) => ({
  organisation: one(organisations, { fields: [venues.organisationId], references: [organisations.id] }),
  rooms: many(rooms),
  services: many(services),
}));

export const roomsRelations = relations(rooms, ({ one }) => ({
  venue: one(venues, { fields: [rooms.venueId], references: [venues.id] }),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  venue: one(venues, { fields: [services.venueId], references: [venues.id] }),
  room: one(rooms, { fields: [services.roomId], references: [rooms.id] }),
  options: many(serviceOptions),
  addOns: many(addOns),
  timetableRules: many(timetableRules),
  timetableExceptions: many(timetableExceptions),
}));

export const serviceOptionsRelations = relations(serviceOptions, ({ one }) => ({
  service: one(services, { fields: [serviceOptions.serviceId], references: [services.id] }),
}));

export const addOnsRelations = relations(addOns, ({ one }) => ({
  service: one(services, { fields: [addOns.serviceId], references: [services.id] }),
}));

export const timetableRulesRelations = relations(timetableRules, ({ one }) => ({
  service: one(services, { fields: [timetableRules.serviceId], references: [services.id] }),
}));

export const timetableExceptionsRelations = relations(timetableExceptions, ({ one }) => ({
  service: one(services, { fields: [timetableExceptions.serviceId], references: [services.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  service: one(services, { fields: [sessions.serviceId], references: [services.id] }),
  room: one(rooms, { fields: [sessions.roomId], references: [rooms.id] }),
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  venue: one(venues, { fields: [bookings.venueId], references: [venues.id] }),
  service: one(services, { fields: [bookings.serviceId], references: [services.id] }),
  room: one(rooms, { fields: [bookings.roomId], references: [rooms.id] }),
  session: one(sessions, { fields: [bookings.sessionId], references: [sessions.id] }),
  customer: one(customers, { fields: [bookings.customerId], references: [customers.id] }),
  payments: many(payments),
  refunds: many(refunds),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  bookings: many(bookings),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
  refunds: many(refunds),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
  booking: one(bookings, { fields: [refunds.bookingId], references: [bookings.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  venues: many(userVenues),
}));

export const userVenuesRelations = relations(userVenues, ({ one }) => ({
  user: one(users, { fields: [userVenues.userId], references: [users.id] }),
  venue: one(venues, { fields: [userVenues.venueId], references: [venues.id] }),
}));

// ---------- row types ----------

export type Organisation = typeof organisations.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Service = typeof services.$inferSelect;
export type ServiceOption = typeof serviceOptions.$inferSelect;
export type AddOn = typeof addOns.$inferSelect;
export type TimetableRule = typeof timetableRules.$inferSelect;
export type TimetableException = typeof timetableExceptions.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type Hold = typeof holds.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type User = typeof users.$inferSelect;
export type UserVenue = typeof userVenues.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type CalendarLogRow = typeof calendarLog.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;

export { sql };
