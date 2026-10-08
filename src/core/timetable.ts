/**
 * Timetable materialisation: rules + exceptions -> session occurrences for a day range.
 * Pure. Dates in = 'YYYY-MM-DD' local; instants out = UTC Dates.
 */
import { addMinutes, eachLocalDay, localWeekday, startOfLocalDay, zonedDateTime, DEFAULT_TZ } from "./time";

export type RuleLike = {
  id: string;
  weekday: number;
  startTime: string;
  capacity: number;
  validFrom: string | null;
  validTo: string | null;
};

export type ExceptionLike = {
  id: string;
  date: string;
  startTime: string | null;
  kind: "cancel" | "add" | "capacity";
  capacity: number | null;
};

export type OccurrenceInput = {
  service: { id: string; venueId: string; roomId: string; lengthMinutes: number };
  venue: { opensAt: Date | null; status: "open" | "opening" | "closed" };
  rules: RuleLike[];
  exceptions: ExceptionLike[];
  from: string;
  to: string;
  tz?: string;
};

export type Occurrence = {
  serviceId: string;
  venueId: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  source: "rule" | "exception";
};

/** Key used to match an occurrence to a stored session row. */
export function occurrenceKey(serviceId: string, startsAt: Date): string {
  return `${serviceId}@${startsAt.toISOString()}`;
}

export function generateOccurrences(input: OccurrenceInput): Occurrence[] {
  const tz = input.tz ?? DEFAULT_TZ;
  const { service, venue } = input;
  if (venue.status === "closed") return [];
  const byKey = new Map<string, Occurrence>();

  for (const day of eachLocalDay(input.from, input.to)) {
    const dayStart = startOfLocalDay(day, tz);
    const weekday = localWeekday(dayStart, tz);
    const exceptionsForDay = input.exceptions.filter((e) => e.date === day);
    const wholeDayCancelled = exceptionsForDay.some((e) => e.kind === "cancel" && e.startTime === null);

    if (!wholeDayCancelled) {
      for (const rule of input.rules) {
        if (rule.weekday !== weekday) continue;
        if (rule.validFrom && day < rule.validFrom) continue;
        if (rule.validTo && day > rule.validTo) continue;
        const startsAt = zonedDateTime(day, rule.startTime, tz);
        const cancelled = exceptionsForDay.some((e) => e.kind === "cancel" && e.startTime === rule.startTime);
        if (cancelled) continue;
        const capEx = exceptionsForDay.find((e) => e.kind === "capacity" && e.startTime === rule.startTime);
        const capacity = capEx?.capacity ?? rule.capacity;
        put(byKey, {
          serviceId: service.id,
          venueId: service.venueId,
          roomId: service.roomId,
          startsAt,
          endsAt: addMinutes(startsAt, service.lengthMinutes),
          capacity,
          source: "rule",
        });
      }
    }

    for (const ex of exceptionsForDay) {
      if (ex.kind !== "add" || !ex.startTime) continue;
      const startsAt = zonedDateTime(day, ex.startTime, tz);
      const key = occurrenceKey(service.id, startsAt);
      const existing = byKey.get(key);
      const fallbackCapacity = existing?.capacity ?? maxRuleCapacity(input.rules) ?? 10;
      byKey.set(key, {
        serviceId: service.id,
        venueId: service.venueId,
        roomId: service.roomId,
        startsAt,
        endsAt: addMinutes(startsAt, service.lengthMinutes),
        capacity: ex.capacity ?? fallbackCapacity,
        source: existing ? existing.source : "exception",
      });
    }
  }

  let out = Array.from(byKey.values());
  if (venue.opensAt) {
    const opensAt = venue.opensAt;
    out = out.filter((o) => o.startsAt.getTime() >= opensAt.getTime());
  }
  out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return out;
}

function put(map: Map<string, Occurrence>, o: Occurrence): void {
  map.set(occurrenceKey(o.serviceId, o.startsAt), o);
}

function maxRuleCapacity(rules: RuleLike[]): number | null {
  if (rules.length === 0) return null;
  return rules.reduce((m, r) => Math.max(m, r.capacity), 0);
}
