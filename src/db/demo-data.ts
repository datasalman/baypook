/**
 * Sample bookings for demo mode only, so the owner's rehearsal shows a
 * populated Today view. Created through the real booking service, then
 * re-labelled as online bookings where appropriate. Never runs in live mode.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "./index";
import * as s from "./schema";
import { addDays, endOfLocalDay, localDate, localWeekday, startOfLocalDay, zonedDateTime } from "@/core/time";

type SampleCustomer = { firstName: string; lastName: string; email: string; phone: string };

const CUSTOMERS: SampleCustomer[] = [
  { firstName: "Amina", lastName: "Khan", email: "amina.khan@example.com", phone: "07700 900101" },
  { firstName: "Priya", lastName: "Patel", email: "priya.patel@example.com", phone: "07700 900102" },
  { firstName: "Chloe", lastName: "Morgan", email: "chloe.morgan@example.com", phone: "07700 900103" },
  { firstName: "Tom", lastName: "Reilly", email: "tom.reilly@example.com", phone: "07700 900104" },
  { firstName: "Fatima", lastName: "Hussain", email: "fatima.h@example.com", phone: "07700 900105" },
  { firstName: "Grace", lastName: "Okafor", email: "grace.okafor@example.com", phone: "07700 900106" },
  { firstName: "Daniel", lastName: "Shaw", email: "dan.shaw@example.com", phone: "07700 900107" },
  { firstName: "Hannah", lastName: "Levy", email: "hannah.levy@example.com", phone: "07700 900108" },
];

export async function seedDemoBookings(db: Db): Promise<{ created: number }> {
  const { getOrganisation, listVenues } = await import("@/server/org");
  const { listServicesForVenue } = await import("@/server/catalogue");
  const { ensureSessions } = await import("@/server/sessions");
  const { createManualBooking } = await import("@/server/bookings");

  const org = await getOrganisation(db);
  const tz = org.timezone;
  const [ownerRow] = await db.select().from(s.users).where(eq(s.users.isOwner, true)).limit(1);
  if (!ownerRow) return { created: 0 };
  const owner = { id: ownerRow.id, email: ownerRow.email, name: ownerRow.name, isOwner: true, venues: [] };

  const venues = await listVenues(db);
  const sw = venues.find((v) => v.slug === "south-woodford") ?? venues[0];
  if (!sw) return { created: 0 };
  const services = await listServicesForVenue(db, sw.id);
  const workshops = services.find((x) => x.kind === "session");
  const slimeParty = services.find((x) => x.slug === "slime-party");
  const decodenParty = services.find((x) => x.slug === "decoden-craft-party");
  if (!workshops || !slimeParty) return { created: 0 };

  const slime = workshops.options.find((o) => /slime/i.test(o.name)) ?? workshops.options[0];
  const decoden = workshops.options.find((o) => /decoden/i.test(o.name)) ?? workshops.options[0];

  const today = localDate(new Date(), tz);
  const from = today;
  const to = addDays(today, 15);
  await ensureSessions(db, workshops, sw, from, to, tz);

  let created = 0;
  let ci = 0;
  const nextCustomer = () => CUSTOMERS[ci++ % CUSTOMERS.length];

  // Parties: next Saturday 11:00 with Food time, and the Saturday after (Decoden) at 15:00.
  const saturdays = Array.from({ length: 16 }, (_, i) => addDays(today, i)).filter(
    (d) => localWeekday(startOfLocalDay(d, tz), tz) === 6 && d > addDays(today, 2),
  );
  const partyPlans: { service: typeof slimeParty | undefined; day: string | undefined; time: string; food: boolean; child: string; age: number }[] = [
    { service: slimeParty, day: saturdays[0], time: "11:00", food: true, child: "Zara", age: 7 },
    { service: decodenParty, day: saturdays[1], time: "15:00", food: false, child: "Leo", age: 9 },
  ];
  for (const plan of partyPlans) {
    if (!plan.service || !plan.day) continue;
    const pkg = plan.service.options[0];
    const extra = plan.service.addOns.find((a) => a.perChild);
    const food = plan.service.addOns.find((a) => a.kind === "time");
    const addOns: { addOnId: string; qty: number }[] = [];
    if (extra) addOns.push({ addOnId: extra.id, qty: 2 });
    if (plan.food && food) addOns.push({ addOnId: food.id, qty: 1 });
    try {
      const booking = await createManualBooking(db, {
        user: owner,
        venue: sw,
        service: plan.service,
        startsAt: zonedDateTime(plan.day, plan.time, tz),
        lines: [{ optionId: pkg.id, qty: 1 }],
        addOns,
        customer: nextCustomer(),
        birthdayChild: { firstName: plan.child, age: plan.age },
        notes: "Parent will bring a cake; please have a knife and plates ready.",
        payment: { method: "card_machine" },
        sendEmail: false,
      });
      await relabelAsOnline(db, booking.id);
      created++;
    } catch {
      // skipped if the slot is not free
    }
  }

  // Workshop bookings: a few places on most open days, heavier at weekends.
  for (let i = 0; i < 16; i++) {
    const day = addDays(today, i);
    const weekday = localWeekday(startOfLocalDay(day, tz), tz);
    const dayStart = startOfLocalDay(day, tz);
    const dayEnd = endOfLocalDay(day, tz);
    const sessions = await db
      .select()
      .from(s.sessions)
      .where(and(eq(s.sessions.serviceId, workshops.id), gte(s.sessions.startsAt, dayStart), lt(s.sessions.startsAt, dayEnd)))
      .orderBy(s.sessions.startsAt);
    if (sessions.length === 0) continue;
    const isWeekend = weekday === 0 || weekday === 6;
    const picks = isWeekend ? [1, 3, 4, 5] : [2, 4];
    for (const idx of picks) {
      const session = sessions[idx];
      if (!session || session.startsAt.getTime() < Date.now()) continue;
      const c = nextCustomer();
      const lines = [{ optionId: slime.id, qty: 1 + ((i + idx) % 3) }];
      if ((i + idx) % 2 === 0 && decoden.id !== slime.id) lines.push({ optionId: decoden.id, qty: 1 });
      const walkIn = i === 0 && idx === picks[0];
      try {
        const booking = await createManualBooking(db, {
          user: owner,
          venue: sw,
          service: workshops,
          sessionId: session.id,
          lines,
          addOns: [],
          customer: walkIn ? { firstName: "Walk-in", lastName: "(cash)", email: null, phone: null } : c,
          notes: (i + idx) % 5 === 0 ? "One child has a nut allergy." : null,
          payment: walkIn ? { method: "cash" } : { method: "card_machine" },
          sendEmail: false,
        });
        if (!walkIn) await relabelAsOnline(db, booking.id);
        created++;
      } catch {
        // a sample that no longer fits (e.g. inside cut-off) is simply skipped
      }
    }
  }

  // One owed booking (to pay in store) and one closed afternoon next week.
  const owedDay = addDays(today, 3);
  const owedSessions = await db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.serviceId, workshops.id), gte(s.sessions.startsAt, startOfLocalDay(owedDay, tz)), lt(s.sessions.startsAt, endOfLocalDay(owedDay, tz))));
  const owedSession = owedSessions[owedSessions.length - 1];
  if (owedSession) {
    try {
      await createManualBooking(db, {
        user: owner,
        venue: sw,
        service: workshops,
        sessionId: owedSession.id,
        lines: [{ optionId: slime.id, qty: 2 }],
        addOns: [],
        customer: nextCustomer(),
        notes: "Phoned to book; will pay when they arrive.",
        payment: { method: "pay_in_store" },
        sendEmail: false,
      });
      created++;
    } catch {
      // ignore
    }
  }
  const blockDay = addDays(today, 6);
  await db.insert(s.blocks).values({
    venueId: sw.id,
    roomId: null,
    startsAt: zonedDateTime(blockDay, "16:00", tz),
    endsAt: zonedDateTime(blockDay, "18:00", tz),
    reason: "Private hire (sample)",
    createdBy: owner.id,
  });

  await db.insert(s.settings).values({ key: "demo.sampleBookings", value: { created, at: new Date().toISOString() } }).onConflictDoNothing();
  return { created };
}

/** Make a sample look like it was booked and paid online. */
async function relabelAsOnline(db: Db, bookingId: string): Promise<void> {
  await db
    .update(s.bookings)
    .set({ source: "online", paymentMethod: "online_card", termsVersion: 1, waiverVersion: 1, acceptedAt: new Date() })
    .where(eq(s.bookings.id, bookingId));
  await db.update(s.payments).set({ provider: "demo", method: "online_card" }).where(eq(s.payments.bookingId, bookingId));
}
