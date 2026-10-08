/** Server-side mapping from a catalogue service to the quantities editor's plain props. */
import type * as s from "@/db/schema";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import type { EditorCatalogue } from "../_components/QuantitiesEditor";

/**
 * Items on sale, in catalogue order. `keep` adds archived items that are already
 * on a booking being changed (they stay allowed there, at the price paid).
 */
export function editorCatalogue(
  service: ServiceWithCatalogue,
  venue: Pick<s.Venue, "maxPlacesPerBooking">,
  keep: { optionIds?: Iterable<string>; addOnIds?: Iterable<string> } = {},
): EditorCatalogue {
  const keepOptions = new Set(keep.optionIds ?? []);
  const keepAddOns = new Set(keep.addOnIds ?? []);
  return {
    kind: service.kind,
    options: service.options
      .filter((o) => !o.archivedAt || keepOptions.has(o.id))
      .map((o) => ({
        id: o.id,
        name: o.name,
        blurb: o.blurb,
        unitPricePence: o.unitPricePence,
        includedChildren: o.includedChildren,
        maxPerBooking: o.maxPerBooking,
        inStoreNoteShort: o.inStoreNoteShort,
      })),
    addOns: service.addOns
      .filter((a) => !a.archivedAt || keepAddOns.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        blurb: a.blurb,
        pricePence: a.pricePence,
        kind: a.kind,
        extraMinutes: a.extraMinutes,
        maxQuantity: a.maxQuantity,
        perChild: a.perChild,
      })),
    maxPlacesPerBooking: venue.maxPlacesPerBooking,
    serviceInStoreNoteShort: service.inStoreNoteShort,
  };
}
