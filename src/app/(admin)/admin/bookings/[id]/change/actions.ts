"use server";

import { unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/server/auth";
import { isUuid } from "@/server/catalogue";
import { previewBookingCounts } from "@/server/bookings";
import { bookingErrorMessage } from "../../_lib/errors";

export type PreviewItem = { key: string; name: string; qty: number; unitPence: number; totalPence: number };
export type CountsPreviewState =
  | { ok: true; items: PreviewItem[]; totalPence: number; places: number; delta: number }
  | { ok: false; error: string };

const MAX_ITEMS = 50;

function clean<K extends "optionId" | "addOnId">(list: unknown, key: K): ({ qty: number } & Record<K, string>)[] {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_ITEMS)
    .map((x: unknown) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {}))
    .filter((x) => typeof x[key] === "string" && Number.isInteger(x.qty) && (x.qty as number) > 0)
    .map((x) => ({ [key]: x[key] as string, qty: x.qty as number }) as { qty: number } & Record<K, string>);
}

/**
 * The price the change page shows before saving: exactly what `changeBookingCounts`
 * would charge (places already paid for keep their price; added places and new
 * extras are at today's price).
 */
export async function previewCountsAction(input: {
  bookingId: string;
  lines: { optionId: string; qty: number }[];
  addOns: { addOnId: string; qty: number }[];
}): Promise<CountsPreviewState> {
  const id = isUuid(input?.bookingId) ? input.bookingId : "";
  if (!id) return { ok: false, error: "We could not find that booking." };
  const user = await requireUser(`/admin/bookings/${id}/change`);
  try {
    const db = await getDb();
    const p = await previewBookingCounts(db, { bookingId: id, user, lines: clean(input.lines, "optionId"), addOns: clean(input.addOns, "addOnId") });
    return {
      ok: true,
      items: [
        ...p.lines.map((l, i) => ({ key: `l${i}:${l.optionId}`, name: l.name, qty: l.qty, unitPence: l.unitPence, totalPence: l.totalPence })),
        ...p.addOns.map((a, i) => ({ key: `a${i}:${a.addOnId}`, name: a.name, qty: a.qty, unitPence: a.unitPence, totalPence: a.totalPence })),
      ],
      totalPence: p.totalPence,
      places: p.places,
      delta: p.delta,
    };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: bookingErrorMessage(e) };
  }
}
