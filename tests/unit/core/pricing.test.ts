import { describe, expect, it } from "vitest";
import { PricingError, quote, type AddOnLike, type OptionLike, type QuoteInput } from "@/core/pricing";

const SLIME: OptionLike = { id: "opt-slime", name: "Slime Workshop", unitPricePence: 1700, includedChildren: null, maxPerBooking: null, archivedAt: null, inStoreNoteShort: null };
const DECODEN: OptionLike = {
  id: "opt-decoden",
  name: "Decoden Craft Workshop",
  unitPricePence: 1000,
  includedChildren: null,
  maxPerBooking: null,
  archivedAt: null,
  inStoreNoteShort: "Decoden pieces are bought in store on the day, £3 to £20 each.",
};
const PACKAGE: OptionLike = { id: "opt-party", name: "Slime Party package", unitPricePence: 20000, includedChildren: 10, maxPerBooking: 1, archivedAt: null, inStoreNoteShort: null };
const EXTRA_CHILD: AddOnLike = { id: "add-child", name: "Extra child", pricePence: 1600, kind: "quantity", extraMinutes: 0, maxQuantity: 10, perChild: true, archivedAt: null };
const FOOD_TIME: AddOnLike = { id: "add-food", name: "Food time", pricePence: 5000, kind: "time", extraMinutes: 30, maxQuantity: 1, perChild: false, archivedAt: null };

function workshop(lines: QuoteInput["lines"], extra: Partial<QuoteInput> = {}): QuoteInput {
  return { serviceKind: "session", options: [SLIME, DECODEN], addOns: [], lines, addOnSelections: [], maxPlacesPerBooking: 10, ...extra };
}
function party(addOnSelections: QuoteInput["addOnSelections"], extra: Partial<QuoteInput> = {}): QuoteInput {
  return {
    serviceKind: "slot",
    options: [PACKAGE],
    addOns: [EXTRA_CHILD, FOOD_TIME],
    lines: [{ optionId: PACKAGE.id, qty: 1 }],
    addOnSelections,
    maxPlacesPerBooking: 10,
    ...extra,
  };
}

function expectPricingError(fn: () => unknown, code: "INVALID" | "LIMIT", limit?: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PricingError);
    expect((e as PricingError).code).toBe(code);
    if (limit !== undefined) expect((e as PricingError).limit).toBe(limit);
    return;
  }
  throw new Error("expected a PricingError");
}

describe("workshop pricing", () => {
  it("prices places per option and lists in-store notes", () => {
    const q = quote(workshop([{ optionId: DECODEN.id, qty: 1 }, { optionId: SLIME.id, qty: 2 }]));
    expect(q.lines).toEqual([
      { optionId: SLIME.id, name: "Slime Workshop", qty: 2, unitPence: 1700, totalPence: 3400, includedChildren: null },
      { optionId: DECODEN.id, name: "Decoden Craft Workshop", qty: 1, unitPence: 1000, totalPence: 1000, includedChildren: null },
    ]);
    expect(q.places).toBe(3);
    expect(q.subtotalPence).toBe(4400);
    expect(q.totalPence).toBe(4400);
    expect(q.extraMinutes).toBe(0);
    expect(q.inStoreNotes).toEqual([DECODEN.inStoreNoteShort]);
  });

  it("drops zero lines and merges repeated options", () => {
    const q = quote(workshop([{ optionId: SLIME.id, qty: 1 }, { optionId: DECODEN.id, qty: 0 }, { optionId: SLIME.id, qty: 2 }]));
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0].qty).toBe(3);
    expect(q.inStoreNotes).toEqual([]);
  });

  it("allows exactly the per-booking maximum and refuses one more with LIMIT 10", () => {
    expect(quote(workshop([{ optionId: SLIME.id, qty: 6 }, { optionId: DECODEN.id, qty: 4 }])).places).toBe(10);
    expectPricingError(() => quote(workshop([{ optionId: SLIME.id, qty: 6 }, { optionId: DECODEN.id, qty: 5 }])), "LIMIT", 10);
  });

  it("honours an option's own maximum", () => {
    const limited = { ...SLIME, maxPerBooking: 4 };
    expectPricingError(() => quote(workshop([{ optionId: SLIME.id, qty: 5 }], { options: [limited, DECODEN] })), "LIMIT", 4);
  });

  it("caps quantity add-ons on sessions", () => {
    const kit: AddOnLike = { id: "kit", name: "Take-home kit", pricePence: 500, kind: "quantity", extraMinutes: 0, maxQuantity: 2, perChild: false, archivedAt: null };
    const ok = quote(workshop([{ optionId: SLIME.id, qty: 1 }], { addOns: [kit], addOnSelections: [{ addOnId: kit.id, qty: 2 }] }));
    expect(ok.totalPence).toBe(1700 + 1000);
    expect(ok.places).toBe(1);
    expectPricingError(
      () => quote(workshop([{ optionId: SLIME.id, qty: 1 }], { addOns: [kit], addOnSelections: [{ addOnId: kit.id, qty: 3 }] })),
      "LIMIT",
      2,
    );
  });

  it("rejects bad input as INVALID", () => {
    expectPricingError(() => quote(workshop([])), "INVALID");
    expectPricingError(() => quote(workshop([{ optionId: SLIME.id, qty: 0 }])), "INVALID");
    expectPricingError(() => quote(workshop([{ optionId: SLIME.id, qty: -1 }])), "INVALID");
    expectPricingError(() => quote(workshop([{ optionId: SLIME.id, qty: 1.5 }])), "INVALID");
    expectPricingError(() => quote(workshop([{ optionId: "nope", qty: 1 }])), "INVALID");
    expectPricingError(() => quote(workshop([{ optionId: "", qty: 1 }])), "INVALID");
    expectPricingError(
      () => quote(workshop([{ optionId: SLIME.id, qty: 1 }], { options: [{ ...SLIME, archivedAt: new Date() }] })),
      "INVALID",
    );
    expectPricingError(
      () => quote(workshop([{ optionId: SLIME.id, qty: 1 }], { addOnSelections: [{ addOnId: "nope", qty: 1 }] })),
      "INVALID",
    );
    expectPricingError(
      () =>
        quote(
          workshop([{ optionId: SLIME.id, qty: 1 }], {
            addOns: [{ ...FOOD_TIME, archivedAt: new Date() }],
            addOnSelections: [{ addOnId: FOOD_TIME.id, qty: 1 }],
          }),
        ),
      "INVALID",
    );
  });

  it("ignores an archived option sent with zero", () => {
    const q = quote(workshop([{ optionId: SLIME.id, qty: 1 }, { optionId: DECODEN.id, qty: 0 }], { options: [SLIME, { ...DECODEN, archivedAt: new Date() }] }));
    expect(q.totalPence).toBe(1700);
  });
});

describe("party pricing", () => {
  it("Slime Party with 3 extra children is £248 for 13 children", () => {
    const q = quote(party([{ addOnId: EXTRA_CHILD.id, qty: 3 }]));
    expect(q.totalPence).toBe(24800);
    expect(q.places).toBe(13);
    expect(q.lines[0]).toMatchObject({ qty: 1, unitPence: 20000, totalPence: 20000, includedChildren: 10 });
    expect(q.addOns).toEqual([
      { addOnId: EXTRA_CHILD.id, name: "Extra child", qty: 3, unitPence: 1600, totalPence: 4800, kind: "quantity", extraMinutes: 0, perChild: true },
    ]);
  });

  it("the package alone covers the included children", () => {
    const q = quote(party([]));
    expect(q).toMatchObject({ totalPence: 20000, places: 10, extraMinutes: 0 });
  });

  it("allows 10 extra (20 children) and refuses 11 with LIMIT 20", () => {
    expect(quote(party([{ addOnId: EXTRA_CHILD.id, qty: 10 }])).places).toBe(20);
    expectPricingError(() => quote(party([{ addOnId: EXTRA_CHILD.id, qty: 11 }])), "LIMIT", 20);
  });

  it("Food time adds £50 and 30 minutes, at most once", () => {
    const q = quote(party([{ addOnId: FOOD_TIME.id, qty: 1 }, { addOnId: EXTRA_CHILD.id, qty: 2 }]));
    expect(q.totalPence).toBe(20000 + 3200 + 5000);
    expect(q.extraMinutes).toBe(30);
    expect(q.places).toBe(12);
    expect(q.addOns.map((a) => a.name)).toEqual(["Extra child", "Food time"]);
    expectPricingError(() => quote(party([{ addOnId: FOOD_TIME.id, qty: 2 }])), "LIMIT", 1);
  });

  it("Decoden Craft Party: 8 included, up to 12 extra (20 children)", () => {
    const pkg = { ...PACKAGE, id: "deco", unitPricePence: 25000, includedChildren: 8 };
    const extra = { ...EXTRA_CHILD, pricePence: 2500, maxQuantity: 12 };
    const input = (qty: number) => party([{ addOnId: extra.id, qty }], { options: [pkg], addOns: [extra, FOOD_TIME], lines: [{ optionId: pkg.id, qty: 1 }] });
    expect(quote(input(12))).toMatchObject({ places: 20, totalPence: 25000 + 30000 });
    expectPricingError(() => quote(input(13)), "LIMIT", 20);
  });

  it("does not apply the workshop per-booking limit to party children", () => {
    expect(quote(party([{ addOnId: EXTRA_CHILD.id, qty: 5 }], { maxPlacesPerBooking: 10 })).places).toBe(15);
  });

  it("needs exactly one package", () => {
    expectPricingError(() => quote(party([], { lines: [{ optionId: PACKAGE.id, qty: 2 }] })), "INVALID");
    const other = { ...PACKAGE, id: "other" };
    expectPricingError(
      () => quote(party([], { options: [PACKAGE, other], lines: [{ optionId: PACKAGE.id, qty: 1 }, { optionId: other.id, qty: 1 }] })),
      "INVALID",
    );
  });

  it("treats a package without an included count as zero children included", () => {
    const pkg = { ...PACKAGE, includedChildren: null };
    const q = quote(party([{ addOnId: EXTRA_CHILD.id, qty: 4 }], { options: [pkg] }));
    expect(q.places).toBe(4);
  });

  it("adds the service's in-store note once", () => {
    const note = "Pieces are chosen on the day.";
    const q = quote(party([], { serviceInStoreNoteShort: note, options: [{ ...PACKAGE, inStoreNoteShort: ` ${note} ` }] }));
    expect(q.inStoreNotes).toEqual([note]);
    expect(quote(party([], { serviceInStoreNoteShort: "  " })).inStoreNotes).toEqual([]);
  });
});
