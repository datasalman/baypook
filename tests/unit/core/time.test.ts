import { describe, expect, it } from "vitest";
import {
  addMinutes,
  endOfLocalDay,
  fmtDayLong,
  fmtDayShort,
  fmtLocal,
  fmtTime,
  isValidDateStr,
  isValidTimeStr,
  localTime,
  minutesBetween,
  minutesToTime,
  overlaps,
  startOfLocalDay,
  timeToMinutes,
  toLocal,
  weekdayKey,
  zonedDateTime,
} from "@/core/time";

describe("overlap edges", () => {
  const four = new Date("2026-10-20T15:00:00Z"); // 16:00 BST
  const three = new Date("2026-10-20T14:00:00Z");
  const five = new Date("2026-10-20T16:00:00Z");
  it("16:00 end vs 16:00 start does not overlap, either way round", () => {
    expect(overlaps(three, four, four, five)).toBe(false);
    expect(overlaps(four, five, three, four)).toBe(false);
  });
  it("one minute either side does", () => {
    expect(overlaps(three, addMinutes(four, 1), four, five)).toBe(true);
    expect(overlaps(addMinutes(four, -1), five, three, four)).toBe(true);
  });
  it("containment and identity overlap", () => {
    expect(overlaps(three, five, four, addMinutes(four, 10))).toBe(true);
    expect(overlaps(three, four, three, four)).toBe(true);
  });
});

describe("time helpers", () => {
  it("does minute arithmetic", () => {
    const a = new Date("2026-10-20T09:00:00Z");
    expect(minutesBetween(a, addMinutes(a, 90))).toBe(90);
  });

  it("local days are 25 hours long when the clocks go back", () => {
    const start = startOfLocalDay("2026-10-25");
    const end = endOfLocalDay("2026-10-25");
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(minutesBetween(start, end)).toBe(25 * 60);
    expect(weekdayKey(start)).toBe("sun");
    expect(localTime(new Date("2026-10-25T01:30:00Z"))).toBe("01:30");
    expect(localTime(new Date("2026-10-25T00:30:00Z"))).toBe("01:30");
  });

  it("validates date and time strings", () => {
    expect(isValidDateStr("2026-10-25")).toBe(true);
    expect(isValidDateStr("2026-02-30")).toBe(false);
    expect(isValidDateStr("26-10-25")).toBe(false);
    expect(isValidTimeStr("09:30")).toBe(true);
    expect(isValidTimeStr("24:00")).toBe(false);
    expect(isValidTimeStr("9:30")).toBe(false);
  });

  it("converts between HH:mm and minutes", () => {
    expect(timeToMinutes("16:30")).toBe(990);
    expect(minutesToTime(990)).toBe("16:30");
    expect(minutesToTime(0)).toBe("00:00");
    expect(zonedDateTime("2026-10-20", "9").toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });

  it("formats for people in London time", () => {
    const d = new Date("2026-10-24T09:00:00Z");
    expect(fmtTime(d)).toBe("10:00");
    expect(fmtDayLong(d)).toBe("Saturday 24 October 2026");
    expect(fmtDayShort(d)).toBe("Sat 24 Oct");
    expect(fmtLocal(d, "yyyy-MM-dd HH:mm")).toBe("2026-10-24 10:00");
    expect(toLocal(d).getHours()).toBe(10); // wall-clock fields read as London time
  });
});
