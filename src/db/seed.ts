/**
 * Seed: Slimedom organisation, South Woodford and Lakeside, catalogue, timetable,
 * demo users and default email templates. Idempotent: skips when an organisation exists.
 * Nothing here is hard-coded anywhere else; everything is editable in the admin.
 */
import { count } from "drizzle-orm";
import type { DbOrTx } from "./index";
import * as s from "./schema";
import type { OpeningHours } from "./schema";
import { DEFAULT_TEMPLATES } from "@/providers/email/defaults";
import { minutesToTime, timeToMinutes, WEEKDAY_KEYS } from "@/core/time";
import { isDemo } from "@/lib/env";

const PLACEHOLDER_TERMS = `These are placeholder terms. The full terms and conditions are at https://slimedom.com/terms and apply to every booking.

In short: bookings are paid in full when made. Places and party slots are not refundable for no-shows or late arrival. If Slimedom has to cancel, you get a full refund or a new date, your choice. Need to change something? Message or call us and we will do our best.`;

const PLACEHOLDER_WAIVER = `Placeholder waiver, to be replaced by the condensed liability waiver at https://slimedom.com/terms.

I understand that slime-making and craft activities involve materials that can stain clothing and that grown-ups are responsible for the children they bring. I have told Slimedom about any allergies or needs the children have, and I will stay on the premises during the activity.`;

export async function seedIfEmpty(db: DbOrTx): Promise<boolean> {
  const [{ n }] = await db.select({ n: count() }).from(s.organisations);
  if (Number(n) > 0) return false;
  await seed(db);
  return true;
}

export type SeedResult = {
  organisationId: string;
  venues: Record<"south-woodford" | "lakeside", string>;
  ownerUserId: string | null;
};

export async function seed(db: DbOrTx): Promise<SeedResult> {
  const [org] = await db
    .insert(s.organisations)
    .values({
      name: "Slimedom",
      tagline: "Magical Kingdom of Slime",
      legalName: "Slimedom Ltd (placeholder: confirm legal name)",
      legalAddress: "Placeholder: registered address to be supplied",
      companyNumber: "Placeholder: company number to be supplied",
      contactEmail: "hello@slimedom.com",
      contactPhone: "+44 7498 254704",
      whatsappUrl: "https://wa.me/447498254704",
      websiteUrl: "https://slimedom.com",
      brandPrimary: "#5bbf3a",
      brandInk: "#1b1f1a",
      termsText: PLACEHOLDER_TERMS,
      termsVersion: 1,
      waiverText: PLACEHOLDER_WAIVER,
      waiverVersion: 1,
      termsUrl: "https://slimedom.com/terms",
      privacyUrl: "https://slimedom.com/privacy",
      retentionMonths: 24,
      holdMinutes: 15,
      reminderHoursBefore: 24,
      timezone: "Europe/London",
      placeholdersPending: ["legalName", "legalAddress", "companyNumber", "termsText", "waiverText", "openingHours"],
    })
    .returning();

  // ----- venues -----
  const swHours: OpeningHours = {
    mon: null,
    tue: { open: "10:00", close: "18:00" },
    wed: { open: "10:00", close: "18:00" },
    thu: { open: "10:00", close: "18:00" },
    fri: { open: "10:00", close: "18:00" },
    sat: { open: "10:00", close: "18:00" },
    sun: { open: "10:00", close: "18:00" },
  };
  const lkHours: OpeningHours = {
    mon: { open: "10:00", close: "20:00" },
    tue: { open: "10:00", close: "20:00" },
    wed: { open: "10:00", close: "20:00" },
    thu: { open: "10:00", close: "20:00" },
    fri: { open: "10:00", close: "20:00" },
    sat: { open: "10:00", close: "20:00" },
    sun: { open: "10:00", close: "20:00" },
  };

  const [sw] = await db
    .insert(s.venues)
    .values({
      organisationId: org.id,
      slug: "south-woodford",
      name: "South Woodford",
      status: "open",
      address: "53A George Lane, South Woodford, London E18 1LN",
      postcode: "E18 1LN",
      mapsUrl: "https://maps.google.com/?q=53A+George+Lane+South+Woodford+London+E18+1LN",
      parkingNotes: "Pay-and-display parking on George Lane; South Woodford station (Central line) is a two-minute walk.",
      openingHours: swHours,
      openingHoursConfirmed: false,
      maxPlacesPerBooking: 10,
      defaultLeadTimeMinutes: 0,
      defaultCutoffMinutes: 60,
      sortOrder: 0,
    })
    .returning();

  const [lk] = await db
    .insert(s.venues)
    .values({
      organisationId: org.id,
      slug: "lakeside",
      name: "Lakeside",
      status: "opening",
      opensAt: new Date("2026-10-17T10:00:00+01:00"),
      address: "Lakeside Shopping Centre, West Thurrock Way, Grays RM20 2ZP",
      postcode: "RM20 2ZP",
      mapsUrl: "https://maps.google.com/?q=Lakeside+Shopping+Centre+West+Thurrock+Way+Grays+RM20+2ZP",
      parkingNotes: "Free parking at Lakeside Shopping Centre; use the entrance nearest us (we will confirm which).",
      openingHours: lkHours,
      openingHoursConfirmed: false,
      maxPlacesPerBooking: 10,
      defaultLeadTimeMinutes: 0,
      defaultCutoffMinutes: 60,
      sortOrder: 1,
    })
    .returning();

  // ----- rooms -----
  const [swMain] = await db.insert(s.rooms).values({ venueId: sw.id, name: "Main room", sortOrder: 0 }).returning();
  const [lkWorkshop] = await db.insert(s.rooms).values({ venueId: lk.id, name: "Workshop floor", sortOrder: 0 }).returning();
  const [lkParty] = await db.insert(s.rooms).values({ venueId: lk.id, name: "Party room", sortOrder: 1 }).returning();

  // ----- catalogue per venue -----
  await seedVenueCatalogue(db, { venue: sw, workshopRoomId: swMain.id, partyRoomId: swMain.id, hours: swHours });
  await seedVenueCatalogue(db, { venue: lk, workshopRoomId: lkWorkshop.id, partyRoomId: lkParty.id, hours: lkHours });

  // ----- users: demo accounts exist only in demo mode; live owners come from `scripts/seed.ts --owner` -----
  let ownerUserId: string | null = null;
  if (isDemo()) {
    const [owner] = await db
      .insert(s.users)
      .values({ email: "owner@demo.baypook", name: "Demo owner", isOwner: true })
      .returning();
    const [swManager] = await db
      .insert(s.users)
      .values({ email: "manager.southwoodford@demo.baypook", name: "Demo manager (South Woodford)", isOwner: false, invitedBy: owner.id })
      .returning();
    const [lkStaff] = await db
      .insert(s.users)
      .values({ email: "staff.lakeside@demo.baypook", name: "Demo staff (Lakeside)", isOwner: false, invitedBy: owner.id })
      .returning();
    await db.insert(s.userVenues).values([
      { userId: swManager.id, venueId: sw.id, role: "manager" },
      { userId: lkStaff.id, venueId: lk.id, role: "staff" },
    ]);
    ownerUserId = owner.id;
  }

  // ----- email templates -----
  // The defaults are generic; Slimedom's confirmation adds its own line about aprons.
  const GLITTER = "What to wear: something you don't mind getting glittery.";
  await db.insert(s.emailTemplates).values(
    DEFAULT_TEMPLATES.map((t) => ({
      organisationId: org.id,
      key: t.key,
      name: t.name,
      subject: t.subject,
      body: t.key === "confirmation" ? t.body.replace(GLITTER, `${GLITTER} Aprons are provided, but slime finds a way.`) : t.body,
    })),
  );

  await db.insert(s.settings).values([{ key: "seed.version", value: 1 }]);

  return { organisationId: org.id, venues: { "south-woodford": sw.id, lakeside: lk.id }, ownerUserId };
}

async function seedVenueCatalogue(
  db: DbOrTx,
  input: { venue: s.Venue; workshopRoomId: string; partyRoomId: string; hours: OpeningHours },
): Promise<void> {
  const { venue } = input;

  // Classic Workshops: session, 60 min, capacity 10, hourly from opening to one hour before closing.
  const [workshops] = await db
    .insert(s.services)
    .values({
      venueId: venue.id,
      roomId: input.workshopRoomId,
      kind: "session",
      slug: "classic-workshops",
      name: "Classic Workshops",
      blurb: "Make your own slime or decorate a decoden piece. One hour, everything provided, take it home.",
      lengthMinutes: 60,
      sortOrder: 0,
      onlineEnabled: true,
      payInStoreEnabled: false,
      leadTimeMinutes: 0,
      cutoffMinutes: 60,
      colour: "#5bbf3a",
    })
    .returning();

  await db.insert(s.serviceOptions).values([
    {
      serviceId: workshops.id,
      name: "Slime Workshop",
      blurb: "Mix, colour and customise your own slime.",
      unitPricePence: 1700,
      sortOrder: 0,
    },
    {
      serviceId: workshops.id,
      name: "Decoden Craft Workshop",
      blurb: "Decorate a phone case, mirror or tray with cream clay and charms.",
      unitPricePence: 1000,
      inStoreNoteLine: "Plus your piece, £3 to £20, bought in store.",
      inStoreNoteShort: "Decoden pieces are bought in store on the day, £3 to £20 each.",
      inStoreMenuUrl: "https://slimedom.com/workshops#decoden-menu",
      sortOrder: 1,
    },
  ]);

  const rules: (typeof s.timetableRules.$inferInsert)[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const hours = input.hours[WEEKDAY_KEYS[weekday]];
    if (!hours) continue;
    const open = timeToMinutes(hours.open);
    const lastStart = timeToMinutes(hours.close) - 60;
    for (let m = open; m <= lastStart; m += 60) {
      rules.push({ serviceId: workshops.id, weekday, startTime: minutesToTime(m), capacity: 10 });
    }
  }
  await db.insert(s.timetableRules).values(rules);

  // Slime Party: slot, 90 min, package £200 for 10 children.
  const [slimeParty] = await db
    .insert(s.services)
    .values({
      venueId: venue.id,
      roomId: input.partyRoomId,
      kind: "slot",
      slug: "slime-party",
      name: "Slime Party",
      blurb: "Ninety minutes of slime-making for the birthday child and friends, led by our team.",
      lengthMinutes: 90,
      slotIntervalMinutes: 30,
      sortOrder: 1,
      onlineEnabled: true,
      leadTimeMinutes: 48 * 60,
      cutoffMinutes: 0,
      colour: "#7c5cff",
    })
    .returning();
  await db.insert(s.serviceOptions).values({
    serviceId: slimeParty.id,
    name: "Slime Party package",
    blurb: "Includes 10 children.",
    unitPricePence: 20000,
    includedChildren: 10,
    maxPerBooking: 1,
    sortOrder: 0,
  });
  await db.insert(s.addOns).values([
    { serviceId: slimeParty.id, name: "Extra child", pricePence: 1600, kind: "quantity", maxQuantity: 10, perChild: true, sortOrder: 0 },
    { serviceId: slimeParty.id, name: "Food time", blurb: "Thirty minutes extra for food (bring your own).", pricePence: 5000, kind: "time", extraMinutes: 30, maxQuantity: 1, sortOrder: 1 },
  ]);

  // Decoden Craft Party: slot, 90 min, package £250 for 8 children.
  const [decodenParty] = await db
    .insert(s.services)
    .values({
      venueId: venue.id,
      roomId: input.partyRoomId,
      kind: "slot",
      slug: "decoden-craft-party",
      name: "Decoden Craft Party",
      blurb: "Ninety minutes of decoden crafting; every child decorates a piece to take home.",
      lengthMinutes: 90,
      slotIntervalMinutes: 30,
      sortOrder: 2,
      onlineEnabled: true,
      leadTimeMinutes: 48 * 60,
      cutoffMinutes: 0,
      colour: "#ff6fae",
    })
    .returning();
  await db.insert(s.serviceOptions).values({
    serviceId: decodenParty.id,
    name: "Decoden Craft Party package",
    blurb: "Includes 8 children and a piece each.",
    unitPricePence: 25000,
    includedChildren: 8,
    maxPerBooking: 1,
    sortOrder: 0,
  });
  await db.insert(s.addOns).values([
    { serviceId: decodenParty.id, name: "Extra child", pricePence: 2500, kind: "quantity", maxQuantity: 12, perChild: true, sortOrder: 0 },
    { serviceId: decodenParty.id, name: "Food time", blurb: "Thirty minutes extra for food (bring your own).", pricePence: 5000, kind: "time", extraMinutes: 30, maxQuantity: 1, sortOrder: 1 },
  ]);
}
