process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import type { CurrentUser } from "@/server/auth";
import { getTemplate, previewTemplate } from "@/server/notifications";
import {
  addRoom,
  bumpTermsVersion,
  createVenue,
  deleteRoom,
  listEmailTemplates,
  renameRoom,
  resetEmailTemplate,
  saveEmailTemplate,
  saveLegalText,
  updateOrganisation,
  updateVenue,
} from "@/server/settings";
import { getOrganisation } from "@/server/org";

let db: Db;
let owner: CurrentUser;
let manager: CurrentUser;
let sw: s.Venue;

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  [sw] = await db.select().from(s.venues).where(eq(s.venues.slug, "south-woodford"));
  const [u] = await db.select().from(s.users).where(eq(s.users.isOwner, true));
  owner = { id: u.id, email: u.email, name: u.name, isOwner: true, venues: [] };
  manager = { id: u.id, email: "m@example.com", name: "M", isOwner: false, venues: [{ venueId: sw.id, role: "manager" }] };
});

describe("organisation", () => {
  it("saving a placeholder field clears its flag; confirm clears without a change", async () => {
    const before = await getOrganisation(db);
    expect(before.placeholdersPending).toContain("legalName");
    expect(before.placeholdersPending).toContain("companyNumber");

    const after = await updateOrganisation(db, owner, { legalName: "Slimedom Ltd", name: before.name });
    expect(after.legalName).toBe("Slimedom Ltd");
    expect(after.placeholdersPending).not.toContain("legalName");
    expect(after.placeholdersPending).toContain("companyNumber");

    const confirmed = await updateOrganisation(db, owner, { companyNumber: before.companyNumber }, { confirm: ["companyNumber"] });
    expect(confirmed.placeholdersPending).not.toContain("companyNumber");

    const [a] = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "organisation.update")).orderBy(desc(s.auditLog.createdAt)).limit(1);
    expect(a).toBeTruthy();
  });

  it("is owner only and validates", async () => {
    await expect(updateOrganisation(db, manager, { name: "X" })).rejects.toThrow(/owner/);
    await expect(updateOrganisation(db, owner, { contactEmail: "nope" })).rejects.toThrow(/email/);
    await expect(updateOrganisation(db, owner, { brandPrimary: "green" })).rejects.toThrow(/colour/);
    await expect(updateOrganisation(db, owner, { timezone: "Mars/Olympus" })).rejects.toThrow(/Time zone/);
  });
});

describe("terms and waiver", () => {
  it("bumpTermsVersion increments; wording-only keeps the version", async () => {
    const v0 = (await getOrganisation(db)).termsVersion;
    expect(await bumpTermsVersion(db, owner)).toBe(v0 + 1);

    const fixed = await saveLegalText(db, owner, { doc: "terms", text: "Fixed a typo.", newVersion: false });
    expect(fixed.termsVersion).toBe(v0 + 1);
    expect(fixed.termsText).toBe("Fixed a typo.");
    expect(fixed.placeholdersPending).not.toContain("termsText");

    const waiver = await saveLegalText(db, owner, { doc: "waiver", text: "New waiver.", newVersion: true });
    expect(waiver.waiverVersion).toBe(2);
    expect(waiver.termsVersion).toBe(v0 + 1);
  });
});

describe("email templates", () => {
  it("saving a template then getTemplate returns the new subject; reset restores the default", async () => {
    const org = await getOrganisation(db);
    await saveEmailTemplate(db, owner, "reminder", { subject: "See you tomorrow, {{firstName}}", body: "Hello {{firstName}}" });
    expect((await getTemplate(db, org.id, "reminder")).subject).toBe("See you tomorrow, {{firstName}}");
    const list = await listEmailTemplates(db, org.id);
    expect(list).toHaveLength(5);
    expect(list.find((t) => t.key === "reminder")?.isDefault).toBe(false);

    const preview = await previewTemplate(db, org.id, "reminder", { subject: "Hi {{firstName}}", body: "Body for {{venueName}}" });
    expect(preview.subject).toBe("Hi Amina");

    await resetEmailTemplate(db, owner, "reminder");
    expect((await listEmailTemplates(db, org.id)).find((t) => t.key === "reminder")?.isDefault).toBe(true);
    await expect(saveEmailTemplate(db, owner, "nope", { subject: "a", body: "b" })).rejects.toThrow(/does not exist/);
  });
});

describe("venues and rooms", () => {
  it("updates a venue, and confirming every venue's hours clears the opening hours flag", async () => {
    const updated = await updateVenue(db, owner, sw.id, { maxPlacesPerBooking: 12, openingHoursConfirmed: true });
    expect(updated.maxPlacesPerBooking).toBe(12);
    expect((await getOrganisation(db)).placeholdersPending).toContain("openingHours");
    const [lk] = await db.select().from(s.venues).where(eq(s.venues.slug, "lakeside"));
    await updateVenue(db, owner, lk.id, { openingHoursConfirmed: true });
    expect((await getOrganisation(db)).placeholdersPending).not.toContain("openingHours");

    await expect(
      updateVenue(db, owner, sw.id, { openingHours: { ...sw.openingHours, mon: { open: "18:00", close: "10:00" } } }),
    ).rejects.toThrow(/closing must be after opening/);
    await expect(updateVenue(db, manager, sw.id, { name: "X" })).rejects.toThrow(/owner/);
  });

  it("creates a venue with a Main room; rooms can be added, renamed and deleted when unused", async () => {
    const { venue, room } = await createVenue(db, owner, { name: "South Woodford" });
    expect(venue.slug).toBe("south-woodford-2");
    expect(room.name).toBe("Main room");

    const extra = await addRoom(db, owner, venue.id, { name: "Party room" });
    const renamed = await renameRoom(db, owner, extra.id, { name: "Back room" });
    expect(renamed.name).toBe("Back room");
    await deleteRoom(db, owner, extra.id);
    await expect(deleteRoom(db, owner, room.id)).rejects.toThrow(/at least one room/);

    const [swRoom] = await db.select().from(s.rooms).where(and(eq(s.rooms.venueId, sw.id)));
    await expect(deleteRoom(db, owner, swRoom.id)).rejects.toThrow(/Services use this room/);
  });
});
