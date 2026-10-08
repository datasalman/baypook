import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/db";
import * as s from "@/db/schema";
import { ensureSessions } from "@/server/sessions";

describe("seed and session materialisation", () => {
  it("seeds two venues with services and generates hourly workshop sessions", async () => {
    const db = await createTestDb({ seed: true });
    const venues = await db.select().from(s.venues);
    expect(venues.map((v) => v.slug).sort()).toEqual(["lakeside", "south-woodford"]);

    const sw = venues.find((v) => v.slug === "south-woodford")!;
    const [workshops] = await db.select().from(s.services).where(eq(s.services.venueId, sw.id));
    const svc = (await db.select().from(s.services).where(eq(s.services.venueId, sw.id))).find((x) => x.kind === "session")!;
    expect(workshops).toBeTruthy();

    // Tuesday 20 Oct 2026, 10:00–18:00 -> starts 10..17 = 8 sessions
    const r = await ensureSessions(db, svc, sw, "2026-10-20", "2026-10-20", "Europe/London");
    expect(r.inserted).toBe(8);
    const again = await ensureSessions(db, svc, sw, "2026-10-20", "2026-10-20", "Europe/London");
    expect(again).toEqual({ inserted: 0, updated: 0, removed: 0 });

    // Monday 19 Oct is closed at South Woodford
    const mon = await ensureSessions(db, svc, sw, "2026-10-19", "2026-10-19", "Europe/London");
    expect(mon.inserted).toBe(0);
  });

  it("offers Lakeside sessions only from its opening date", async () => {
    const db = await createTestDb({ seed: true });
    const [lk] = await db.select().from(s.venues).where(eq(s.venues.slug, "lakeside"));
    const svc = (await db.select().from(s.services).where(eq(s.services.venueId, lk.id))).find((x) => x.kind === "session")!;
    const before = await ensureSessions(db, svc, lk, "2026-10-16", "2026-10-16", "Europe/London");
    expect(before.inserted).toBe(0);
    const openingDay = await ensureSessions(db, svc, lk, "2026-10-17", "2026-10-17", "Europe/London");
    expect(openingDay.inserted).toBe(10); // 10:00..19:00
  });
});
