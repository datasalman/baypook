/**
 * Pricing: turns a selection of options and add-ons into a server-side quote.
 * Pure. Money in integer pence. Never trust a client's totals: the checkout is
 * always built from this quote.
 */
import type { BookingAddOn, BookingLine } from "@/db/schema";

export type PricingErrorCode = "INVALID" | "LIMIT";

export class PricingError extends Error {
  code: PricingErrorCode;
  limit?: number;
  constructor(code: PricingErrorCode, message: string, limit?: number) {
    super(message);
    this.name = "PricingError";
    this.code = code;
    if (limit !== undefined) this.limit = limit;
  }
}

export type OptionLike = {
  id: string;
  name: string;
  unitPricePence: number;
  includedChildren: number | null;
  maxPerBooking: number | null;
  archivedAt: Date | null;
  inStoreNoteShort: string | null;
};

export type AddOnLike = {
  id: string;
  name: string;
  pricePence: number;
  kind: "quantity" | "time";
  extraMinutes: number;
  maxQuantity: number;
  perChild: boolean;
  archivedAt: Date | null;
};

export type QuoteInput = {
  serviceKind: "session" | "slot";
  options: OptionLike[];
  addOns: AddOnLike[];
  lines: { optionId: string; qty: number }[];
  addOnSelections: { addOnId: string; qty: number }[];
  maxPlacesPerBooking: number;
  serviceInStoreNoteShort?: string | null;
};

export type Quote = {
  lines: BookingLine[];
  addOns: BookingAddOn[];
  subtotalPence: number;
  totalPence: number;
  /** Session: places booked. Slot: total children (included + extra). */
  places: number;
  /** Minutes added to a slot by time add-ons (e.g. Food time). */
  extraMinutes: number;
  inStoreNotes: string[];
};

function isQty(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Sum quantities per id (a client may send the same id twice), keeping first-seen order. */
function mergeQty<K extends string>(items: ({ qty: number } & Record<K, string>)[], key: K, what: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const id = item[key];
    if (typeof id !== "string" || id === "") throw new PricingError("INVALID", `Each ${what} needs an id.`);
    if (!isQty(item.qty)) throw new PricingError("INVALID", `Quantities must be whole numbers of zero or more.`);
    out.set(id, (out.get(id) ?? 0) + item.qty);
  }
  return out;
}

export function quote(input: QuoteInput): Quote {
  const lineQty = mergeQty(input.lines, "optionId", "option");
  const addOnQty = mergeQty(input.addOnSelections, "addOnId", "add-on");

  const optionsById = new Map(input.options.map((o) => [o.id, o]));
  const addOnsById = new Map(input.addOns.map((a) => [a.id, a]));

  for (const [id, qty] of lineQty) {
    const option = optionsById.get(id);
    if (!option) throw new PricingError("INVALID", "That option is not available for this booking.");
    if (option.archivedAt && qty > 0) throw new PricingError("INVALID", `${option.name} is no longer available.`);
  }
  for (const [id, qty] of addOnQty) {
    const addOn = addOnsById.get(id);
    if (!addOn) throw new PricingError("INVALID", "That extra is not available for this booking.");
    if (addOn.archivedAt && qty > 0) throw new PricingError("INVALID", `${addOn.name} is no longer available.`);
  }

  // Lines in the catalogue's order, only those chosen.
  const chosenOptions = input.options.filter((o) => (lineQty.get(o.id) ?? 0) > 0);
  if (chosenOptions.length === 0) throw new PricingError("INVALID", "Choose at least one place.");

  const lines: BookingLine[] = chosenOptions.map((o) => {
    const qty = lineQty.get(o.id) ?? 0;
    return {
      optionId: o.id,
      name: o.name,
      qty,
      unitPence: o.unitPricePence,
      totalPence: qty * o.unitPricePence,
      includedChildren: o.includedChildren,
    };
  });

  const chosenAddOns = input.addOns.filter((a) => (addOnQty.get(a.id) ?? 0) > 0);
  let places: number;

  if (input.serviceKind === "session") {
    for (const line of lines) {
      const option = optionsById.get(line.optionId)!;
      if (option.maxPerBooking !== null && line.qty > option.maxPerBooking) {
        throw new PricingError("LIMIT", `${option.name}: up to ${option.maxPerBooking} per booking.`, option.maxPerBooking);
      }
    }
    places = lines.reduce((n, l) => n + l.qty, 0);
    if (places > input.maxPlacesPerBooking) {
      throw new PricingError("LIMIT", `Up to ${input.maxPlacesPerBooking} places per booking.`, input.maxPlacesPerBooking);
    }
    for (const a of chosenAddOns) {
      const qty = addOnQty.get(a.id) ?? 0;
      if (qty > a.maxQuantity) throw new PricingError("LIMIT", `${a.name}: up to ${a.maxQuantity}.`, a.maxQuantity);
    }
  } else {
    if (lines.length !== 1 || lines[0].qty !== 1) {
      throw new PricingError("INVALID", "Choose one package for a party.");
    }
    const included = lines[0].includedChildren ?? 0;
    let extraChildren = 0;
    for (const a of chosenAddOns) {
      const qty = addOnQty.get(a.id) ?? 0;
      if (a.perChild) {
        if (qty > a.maxQuantity) {
          const maxChildren = included + a.maxQuantity;
          throw new PricingError("LIMIT", `Up to ${maxChildren} children in total.`, maxChildren);
        }
        extraChildren += qty;
      } else if (qty > a.maxQuantity) {
        throw new PricingError("LIMIT", `${a.name}: up to ${a.maxQuantity}.`, a.maxQuantity);
      }
    }
    places = included + extraChildren;
  }

  const addOns: BookingAddOn[] = chosenAddOns.map((a) => {
    const qty = addOnQty.get(a.id) ?? 0;
    return {
      addOnId: a.id,
      name: a.name,
      qty,
      unitPence: a.pricePence,
      totalPence: qty * a.pricePence,
      kind: a.kind,
      extraMinutes: a.kind === "time" ? a.extraMinutes * qty : 0,
      perChild: a.perChild,
    };
  });

  const extraMinutes = addOns.reduce((n, a) => n + a.extraMinutes, 0);
  const subtotalPence = lines.reduce((n, l) => n + l.totalPence, 0) + addOns.reduce((n, a) => n + a.totalPence, 0);

  const notes: string[] = [];
  const pushNote = (note: string | null | undefined) => {
    const t = note?.trim();
    if (t && !notes.includes(t)) notes.push(t);
  };
  for (const o of chosenOptions) pushNote(o.inStoreNoteShort);
  pushNote(input.serviceInStoreNoteShort);

  return {
    lines,
    addOns,
    subtotalPence,
    totalPence: subtotalPence,
    places,
    extraMinutes,
    inStoreNotes: notes,
  };
}
