/**
 * Customer visibility and notes for the admin. Customers belong to the
 * organisation, but staff and managers only see parents who have booked at one
 * of their venues; the owner sees everyone.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { isUuid } from "@/server/catalogue";

export class CustomerAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerAdminError";
  }
}

/** Venue ids a user's customer views are limited to; null = every venue (owner). */
export function customerVenueScope(user: CurrentUser): string[] | null {
  return user.isOwner ? null : user.venues.map((v) => v.venueId);
}

/** The subset of `customerIds` the user may see. */
export async function visibleCustomerIds(db: DbOrTx, user: CurrentUser, customerIds: string[]): Promise<Set<string>> {
  const ids = customerIds.filter(isUuid);
  if (!ids.length) return new Set();
  const scope = customerVenueScope(user);
  if (scope === null) return new Set(ids);
  if (!scope.length) return new Set();
  const rows = await db
    .selectDistinct({ id: s.bookings.customerId })
    .from(s.bookings)
    .where(and(inArray(s.bookings.customerId, ids), inArray(s.bookings.venueId, scope)));
  return new Set(rows.map((r) => r.id));
}

export async function canSeeCustomer(db: DbOrTx, user: CurrentUser, customerId: string): Promise<boolean> {
  return (await visibleCustomerIds(db, user, [customerId])).has(customerId);
}

/** Replace a customer's internal notes. Audited. */
export async function updateCustomerNotes(
  db: DbOrTx,
  input: { customerId: string; user: CurrentUser; notes: string },
): Promise<s.Customer> {
  const { user } = input;
  if (!isUuid(input.customerId) || !(await canSeeCustomer(db, user, input.customerId))) {
    throw new CustomerAdminError("We could not find that customer.");
  }
  const notes = input.notes.trim();
  if (notes.length > 5000) throw new CustomerAdminError("Notes can be up to 5,000 characters.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(s.customers).where(eq(s.customers.id, input.customerId)).limit(1).for("update");
    if (!before) throw new CustomerAdminError("We could not find that customer.");
    if (before.anonymisedAt) throw new CustomerAdminError("This customer's details were removed under the retention rule.");
    const [after] = await tx
      .update(s.customers)
      .set({ notes: notes || null, updatedAt: new Date() })
      .where(eq(s.customers.id, before.id))
      .returning();
    await audit(tx, {
      user,
      action: "customer.notes",
      entityType: "customer",
      entityId: before.id,
      venueId: null,
      before: { notes: before.notes },
      after: { notes: after.notes },
    });
    return after;
  });
}
