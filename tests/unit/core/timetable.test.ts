import { describe, expect, it } from "vitest";
import { generateOccurrences, occurrenceKey, type ExceptionLike, type OccurrenceInput, type RuleLike } from "@/core/timetable";

const SERVICE = { id: "svc", venueId: "venue", roomId: "room", lengthMinutes: 60 };
const OPEN = { opensAt: null, status: "open" as const };

/** 10:00 every day of the week, capacity 10. */
const TEN_AM: RuleLike[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  id: `r${weekday}`,
  weekday,
  startTime: "10:00",
  capacity: 10,
  validFrom: null,
  validTo: null,
}));

function gen(extra: Partial<OccurrenceInput> = {}) {
  return generateOccurrences({ service: SERVICE, venue: OPEN, rules: TEN_AM, exceptions: [], from: "2026-10-24", to: "2026-10-26", ...extra });
}

describe("timetable across the BST to GMT weekend", () => {
  it("a 10:00 session is 09:00Z on Saturday 24 Oct and 10:00Z on Sunday 25 Oct", () => {
    const out = gen();
    expect(out.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-10-24T09:00:00.000Z",
      "2026-10-25T10:00:00.000Z",
      "2026-10-26T10:00:00.000Z",
    ]);
    expect(out[0].endsAt.toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(out[1]).toMatchObject({ serviceId: "svc", venueId: "venue", roomId: "room", capacity: 10, source: "rule" });
  });
});

describe("timetable rules and exceptions", () => {
  it("honours validFrom and validTo", () => {
    const rules = TEN_AM.map((r) => ({ ...r, validFrom: "2026-10-25", validTo: "2026-10-25" }));
    expect(gen({ rules }).map((o) => o.startsAt.toISOString())).toEqual(["2026-10-25T10:00:00.000Z"]);
  });

  it("cancels a whole day or one start, and changes one start's capacity", () => {
    const exceptions: ExceptionLike[] = [
      { id: "e1", date: "2026-10-24", startTime: null, kind: "cancel", capacity: null },
      { id: "e2", date: "2026-10-25", startTime: "10:00", kind: "cancel", capacity: null },
      { id: "e3", date: "2026-10-26", startTime: "10:00", kind: "capacity", capacity: 4 },
    ];
    const out = gen({ exceptions });
    expect(out).toHaveLength(1);
    expect(out[0].capacity).toBe(4);
  });

  it("adds extra sessions, keeping a rule's source when it coincides", () => {
    const exceptions: ExceptionLike[] = [
      { id: "a1", date: "2026-10-24", startTime: "15:00", kind: "add", capacity: 6 },
      { id: "a2", date: "2026-10-25", startTime: "10:00", kind: "add", capacity: null },
      { id: "a3", date: "2026-10-26", startTime: "16:00", kind: "add", capacity: null },
      { id: "a4", date: "2026-10-26", startTime: null, kind: "add", capacity: null },
    ];
    const out = gen({ exceptions });
    const byKey = new Map(out.map((o) => [o.startsAt.toISOString(), o]));
    expect(byKey.get("2026-10-24T14:00:00.000Z")).toMatchObject({ capacity: 6, source: "exception" });
    expect(byKey.get("2026-10-25T10:00:00.000Z")).toMatchObject({ capacity: 10, source: "rule" });
    expect(byKey.get("2026-10-26T16:00:00.000Z")).toMatchObject({ capacity: 10, source: "exception" });
    expect(out).toHaveLength(5);
  });

  it("falls back to capacity 10 for an added session with no rules", () => {
    const out = gen({ rules: [], exceptions: [{ id: "a", date: "2026-10-24", startTime: "11:00", kind: "add", capacity: null }] });
    expect(out).toHaveLength(1);
    expect(out[0].capacity).toBe(10);
  });

  it("offers nothing at a closed venue and nothing before the opening date", () => {
    expect(gen({ venue: { opensAt: null, status: "closed" } })).toEqual([]);
    const out = gen({ venue: { opensAt: new Date("2026-10-25T10:00:00Z"), status: "opening" } });
    expect(out.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-25T10:00:00.000Z", "2026-10-26T10:00:00.000Z"]);
  });

  it("keys occurrences by service and instant", () => {
    expect(occurrenceKey("svc", new Date("2026-10-25T10:00:00Z"))).toBe("svc@2026-10-25T10:00:00.000Z");
  });
});
