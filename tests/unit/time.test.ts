import { describe, expect, it } from "vitest";
import { addDays, eachLocalDay, fmtPence, localDate, localWeekday, overlaps, zonedDateTime } from "@/core/time";

describe("overlaps", () => {
  it("treats a 16:00 end and 16:00 start as not overlapping", () => {
    const a1 = new Date("2026-10-20T14:00:00Z");
    const a2 = new Date("2026-10-20T16:00:00Z");
    const b1 = new Date("2026-10-20T16:00:00Z");
    const b2 = new Date("2026-10-20T17:00:00Z");
    expect(overlaps(a1, a2, b1, b2)).toBe(false);
    expect(overlaps(b1, b2, a1, a2)).toBe(false);
    expect(overlaps(a1, a2, new Date("2026-10-20T15:59:00Z"), b2)).toBe(true);
  });
});

describe("London time", () => {
  it("builds BST instants before the clocks change and GMT after", () => {
    // Clocks go back on Sunday 25 October 2026 at 02:00 BST.
    expect(zonedDateTime("2026-10-24", "10:00").toISOString()).toBe("2026-10-24T09:00:00.000Z");
    expect(zonedDateTime("2026-10-25", "10:00").toISOString()).toBe("2026-10-25T10:00:00.000Z");
  });
  it("reads local dates and weekdays", () => {
    expect(localDate(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25"); // 00:30 BST
    expect(localWeekday(new Date("2026-10-25T12:00:00Z"))).toBe(0); // Sunday
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(eachLocalDay("2026-10-24", "2026-10-26")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });
});

describe("fmtPence", () => {
  it("formats pence", () => {
    expect(fmtPence(1700)).toBe("£17.00");
    expect(fmtPence(1700, true)).toBe("£17");
    expect(fmtPence(1050, true)).toBe("£10.50");
    expect(fmtPence(-250)).toBe("-£2.50");
  });
});
