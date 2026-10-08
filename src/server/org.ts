import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";

/** The single organisation row. */
export async function getOrganisation(db: DbOrTx): Promise<s.Organisation> {
  const [org] = await db.select().from(s.organisations).limit(1);
  if (!org) throw new Error("No organisation seeded");
  return org;
}

export async function listVenues(db: DbOrTx): Promise<s.Venue[]> {
  return db.select().from(s.venues).orderBy(asc(s.venues.sortOrder), asc(s.venues.name));
}

export async function getVenueBySlug(db: DbOrTx, slug: string): Promise<s.Venue | null> {
  const [v] = await db.select().from(s.venues).where(eq(s.venues.slug, slug)).limit(1);
  return v ?? null;
}

export async function getVenueById(db: DbOrTx, id: string): Promise<s.Venue | null> {
  const [v] = await db.select().from(s.venues).where(eq(s.venues.id, id)).limit(1);
  return v ?? null;
}
