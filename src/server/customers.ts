/**
 * Customers: one record per parent within the organisation, matched by e-mail
 * (case-insensitive). Venue-agnostic: the same parent can book at either venue.
 */
import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { isUuid } from "./catalogue";

export type CustomerInput = {
  organisationId: string;
  firstName: string;
  lastName: string;
  /** Blank for a walk-in who gave no e-mail: a new customer is always created then. */
  email: string;
  phone?: string | null;
};

function clean(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/\s+/g, " ");
}

export function normaliseCustomerEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Find the customer by lower-cased e-mail within the organisation, updating the
 * name and phone when they changed; otherwise create one.
 */
export async function findOrCreateCustomer(tx: DbOrTx, input: CustomerInput): Promise<s.Customer> {
  const email = normaliseCustomerEmail(input.email);
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  const phone = clean(input.phone) || null;

  if (email) {
    const [existing] = await tx
      .select()
      .from(s.customers)
      .where(
        and(
          eq(s.customers.organisationId, input.organisationId),
          sql`lower(${s.customers.email}) = ${email}`,
          isNull(s.customers.anonymisedAt),
        ),
      )
      .orderBy(asc(s.customers.createdAt))
      .limit(1);
    if (existing) {
      const changes: Partial<typeof s.customers.$inferInsert> = {};
      if (firstName && firstName !== existing.firstName) changes.firstName = firstName;
      if (lastName && lastName !== existing.lastName) changes.lastName = lastName;
      if (phone && phone !== existing.phone) changes.phone = phone;
      if (Object.keys(changes).length === 0) return existing;
      const [updated] = await tx
        .update(s.customers)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(s.customers.id, existing.id))
        .returning();
      return updated ?? existing;
    }
  }

  const [created] = await tx
    .insert(s.customers)
    .values({ organisationId: input.organisationId, firstName, lastName, email, phone })
    .returning();
  return created;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search by name, e-mail or phone (case-insensitive). Most recently updated first.
 * `venueIds` limits it (in SQL, before the limit) to parents who booked at one of
 * those venues (staff and managers); null or omitted = everyone (owner).
 */
export async function searchCustomers(
  db: DbOrTx,
  opts: { q?: string; limit?: number; venueIds?: string[] | null } = {},
): Promise<s.Customer[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: SQL[] = [isNull(s.customers.anonymisedAt)];
  if (Array.isArray(opts.venueIds)) {
    if (opts.venueIds.length === 0) return [];
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(s.bookings)
          .where(and(eq(s.bookings.customerId, s.customers.id), inArray(s.bookings.venueId, opts.venueIds))),
      ),
    );
  }
  const q = opts.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const digits = q.replace(/\D/g, "");
    const parts: (SQL | undefined)[] = [
      ilike(s.customers.firstName, like),
      ilike(s.customers.lastName, like),
      ilike(s.customers.email, like),
      ilike(s.customers.phone, like),
      sql`(${s.customers.firstName} || ' ' || ${s.customers.lastName}) ilike ${like}`,
    ];
    // "07700 900123" should find "07700900123" and the other way round.
    if (digits.length >= 4) {
      parts.push(sql`regexp_replace(coalesce(${s.customers.phone}, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`);
    }
    const cond = or(...parts);
    if (cond) where.push(cond);
  }
  return db
    .select()
    .from(s.customers)
    .where(and(...where))
    .orderBy(desc(s.customers.updatedAt))
    .limit(limit);
}

export type CustomerBooking = s.Booking & { serviceName: string; serviceKind: s.Service["kind"]; venueName: string; venueSlug: string };

/**
 * A customer and their bookings, newest first. `venueIds` limits the bookings to
 * those venues (staff and managers); null or omitted = every venue (owner).
 */
export async function getCustomerWithBookings(
  db: DbOrTx,
  id: string,
  opts: { venueIds?: string[] | null } = {},
): Promise<{ customer: s.Customer; bookings: CustomerBooking[] } | null> {
  if (!isUuid(id)) return null;
  const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, id)).limit(1);
  if (!customer) return null;
  const conds: SQL[] = [eq(s.bookings.customerId, id)];
  if (Array.isArray(opts.venueIds)) {
    if (opts.venueIds.length === 0) return { customer, bookings: [] };
    conds.push(inArray(s.bookings.venueId, opts.venueIds));
  }
  const rows = await db
    .select({
      booking: s.bookings,
      serviceName: s.services.name,
      serviceKind: s.services.kind,
      venueName: s.venues.name,
      venueSlug: s.venues.slug,
    })
    .from(s.bookings)
    .innerJoin(s.services, eq(s.services.id, s.bookings.serviceId))
    .innerJoin(s.venues, eq(s.venues.id, s.bookings.venueId))
    .where(and(...conds))
    .orderBy(desc(s.bookings.startsAt));
  return {
    customer,
    bookings: rows.map((r) => ({
      ...r.booking,
      serviceName: r.serviceName,
      serviceKind: r.serviceKind,
      venueName: r.venueName,
      venueSlug: r.venueSlug,
    })),
  };
}
