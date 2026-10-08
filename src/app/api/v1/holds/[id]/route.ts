import { getDb } from "@/db";
import { json, preflight, withApi } from "@/lib/api";
import { getHold, releaseHold } from "@/server/holds";
import { cancelPendingBooking } from "@/server/bookings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const OPTIONS = preflight;

type Ctx = { params: Promise<{ id: string }> };

/** Release a hold early (the customer changed their mind). Idempotent; unknown ids too. */
export const DELETE = withApi<Ctx>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const db = await getDb();
  const hold = await getHold(db, id);
  if (hold && hold.status === "active") {
    // A pending booking already made from this hold gives its places back too.
    if (hold.bookingId) await cancelPendingBooking(db, { bookingId: hold.bookingId, reason: "abandoned" });
    await releaseHold(db, hold.id);
  }
  return json({ released: true });
});
