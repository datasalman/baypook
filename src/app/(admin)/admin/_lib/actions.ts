"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { listVenues } from "@/server/org";
import { requireUser } from "@/server/auth";
import { setSelectedVenueCookie } from "@/server/venue-scope";

/** Change the admin's selected venue (a venue id, or "all" for the owner). */
export async function selectVenue(venueId: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const db = await getDb();
  const all = await listVenues(db);
  const stored = await setSelectedVenueCookie(
    user,
    String(venueId),
    all.map((v) => v.id),
  );
  if (stored) revalidatePath("/admin", "layout");
  return { ok: Boolean(stored) };
}
