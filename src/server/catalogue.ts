/**
 * Catalogue reads: services with their options, add-ons and room.
 * Archived rows are hidden unless asked for; everything is in the admin's sort order.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";

export type ServiceWithCatalogue = s.Service & { options: s.ServiceOption[]; addOns: s.AddOn[]; room: s.Room };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed UUID (so a bad id from a URL is "not found", not a database error). */
export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function bySortThenName<T extends { sortOrder: number; name: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

async function attachCatalogue(
  db: DbOrTx,
  services: s.Service[],
  includeArchived: boolean,
): Promise<ServiceWithCatalogue[]> {
  if (services.length === 0) return [];
  const serviceIds = services.map((x) => x.id);
  const roomIds = Array.from(new Set(services.map((x) => x.roomId)));
  const [options, addOns, rooms] = await Promise.all([
    db
      .select()
      .from(s.serviceOptions)
      .where(
        includeArchived
          ? inArray(s.serviceOptions.serviceId, serviceIds)
          : and(inArray(s.serviceOptions.serviceId, serviceIds), isNull(s.serviceOptions.archivedAt)),
      )
      .orderBy(asc(s.serviceOptions.sortOrder), asc(s.serviceOptions.name)),
    db
      .select()
      .from(s.addOns)
      .where(
        includeArchived
          ? inArray(s.addOns.serviceId, serviceIds)
          : and(inArray(s.addOns.serviceId, serviceIds), isNull(s.addOns.archivedAt)),
      )
      .orderBy(asc(s.addOns.sortOrder), asc(s.addOns.name)),
    db.select().from(s.rooms).where(inArray(s.rooms.id, roomIds)),
  ]);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const out: ServiceWithCatalogue[] = [];
  for (const svc of services) {
    const room = roomById.get(svc.roomId);
    if (!room) continue; // FK guarantees this; skip defensively
    out.push({
      ...svc,
      options: options.filter((o) => o.serviceId === svc.id).sort(bySortThenName),
      addOns: addOns.filter((a) => a.serviceId === svc.id).sort(bySortThenName),
      room,
    });
  }
  return out;
}

export async function listServicesForVenue(
  db: DbOrTx,
  venueId: string,
  opts: { includeArchived?: boolean; onlineOnly?: boolean } = {},
): Promise<ServiceWithCatalogue[]> {
  if (!isUuid(venueId)) return [];
  const includeArchived = opts.includeArchived ?? false;
  const conds = [eq(s.services.venueId, venueId)];
  if (!includeArchived) conds.push(isNull(s.services.archivedAt));
  if (opts.onlineOnly) conds.push(eq(s.services.onlineEnabled, true));
  const rows = await db
    .select()
    .from(s.services)
    .where(and(...conds))
    .orderBy(asc(s.services.sortOrder), asc(s.services.name));
  return attachCatalogue(db, rows, includeArchived);
}

export async function getService(
  db: DbOrTx,
  serviceId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ServiceWithCatalogue | null> {
  if (!isUuid(serviceId)) return null;
  const includeArchived = opts.includeArchived ?? false;
  const [row] = await db.select().from(s.services).where(eq(s.services.id, serviceId)).limit(1);
  if (!row || (row.archivedAt && !includeArchived)) return null;
  const [svc] = await attachCatalogue(db, [row], includeArchived);
  return svc ?? null;
}

export async function getServiceBySlug(db: DbOrTx, venueId: string, slug: string): Promise<ServiceWithCatalogue | null> {
  if (!isUuid(venueId)) return null;
  const [row] = await db
    .select()
    .from(s.services)
    .where(and(eq(s.services.venueId, venueId), eq(s.services.slug, slug), isNull(s.services.archivedAt)))
    .limit(1);
  if (!row) return null;
  const [svc] = await attachCatalogue(db, [row], false);
  return svc ?? null;
}

/** A service by id or slug within a venue (the public API accepts either). */
export async function getServiceForVenue(db: DbOrTx, venueId: string, idOrSlug: string): Promise<ServiceWithCatalogue | null> {
  if (isUuid(idOrSlug)) {
    const svc = await getService(db, idOrSlug);
    return svc && svc.venueId === venueId ? svc : null;
  }
  return getServiceBySlug(db, venueId, idOrSlug);
}
