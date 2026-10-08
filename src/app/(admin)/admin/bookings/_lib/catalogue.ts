/** Server-side mapping from a catalogue service to the quantities editor's plain props. */
import type * as s from "@/db/schema";
import type { ServiceWithCatalogue } from "@/server/catalogue";
import type { EditorCatalogue } from "../_components/QuantitiesEditor";

export function editorCatalogue(service: ServiceWithCatalogue, venue: Pick<s.Venue, "maxPlacesPerBooking">): EditorCatalogue {
  return {
    kind: service.kind,
    options: service.options
      .filter((o) => !o.archivedAt)
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
      .filter((a) => !a.archivedAt)
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
