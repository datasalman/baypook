/**
 * Server-side quote: maps catalogue rows into the pure `quote()`.
 * The checkout is always built from this, never from client totals.
 */
import type { DbOrTx } from "@/db";
import type * as s from "@/db/schema";
import { quote, type Quote, type QuoteInput } from "@/core/pricing";
import type { ServiceWithCatalogue } from "./catalogue";

export type QuoteRequest = {
  service: ServiceWithCatalogue;
  venue: Pick<s.Venue, "maxPlacesPerBooking">;
  lines: { optionId: string; qty: number }[];
  addOns: { addOnId: string; qty: number }[];
};

export function toQuoteInput(req: QuoteRequest): QuoteInput {
  const { service, venue } = req;
  return {
    serviceKind: service.kind,
    options: service.options.map((o) => ({
      id: o.id,
      name: o.name,
      unitPricePence: o.unitPricePence,
      includedChildren: o.includedChildren,
      maxPerBooking: o.maxPerBooking,
      archivedAt: o.archivedAt,
      inStoreNoteShort: o.inStoreNoteShort,
    })),
    addOns: service.addOns.map((a) => ({
      id: a.id,
      name: a.name,
      pricePence: a.pricePence,
      kind: a.kind,
      extraMinutes: a.extraMinutes,
      maxQuantity: a.maxQuantity,
      perChild: a.perChild,
      archivedAt: a.archivedAt,
    })),
    lines: req.lines,
    addOnSelections: req.addOns,
    maxPlacesPerBooking: venue.maxPlacesPerBooking,
    serviceInStoreNoteShort: service.inStoreNoteShort,
  };
}

/**
 * Quote for a service. Synchronous and pure: the catalogue is already loaded on
 * `service`. `db` is accepted for call-site symmetry and future use.
 * Throws `PricingError` (INVALID | LIMIT).
 */
export function quoteForService(_db: DbOrTx | null, req: QuoteRequest): Quote {
  return quote(toQuoteInput(req));
}
