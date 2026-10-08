"use server";

import { getDb } from "@/db";
import type { OpeningHours } from "@/db/schema";
import { WEEKDAY_KEYS, zonedDateTime } from "@/core/time";
import { requireUser } from "@/server/auth";
import { adminErrorMessage } from "@/server/catalogue-admin";
import { getOrganisation } from "@/server/org";
import { previewTemplate } from "@/server/notifications";
import {
  addRoom,
  assertOwner,
  createVenue,
  deleteRoom,
  isTemplateKey,
  renameRoom,
  resetEmailTemplate,
  saveEmailTemplate,
  saveLegalText,
  updateOrganisation,
  updateVenue,
} from "@/server/settings";
import type { FormActionState } from "@/components/ui/form-state";
import { backPath, bool, hoursToMinutes, num, runAdminAction, runAdminFormAction, str } from "../catalogue/_lib/form";

// ---------- organisation ----------

/** Used with <ActionForm>: an error keeps everything typed. */
export async function saveOrganisationAction(_prev: FormActionState, fd: FormData): Promise<FormActionState> {
  return runAdminFormAction(backPath(fd, "/admin/settings"), async ({ db, user }) => {
    await updateOrganisation(
      db,
      user,
      {
        name: str(fd, "name"),
        tagline: str(fd, "tagline"),
        legalName: str(fd, "legalName"),
        legalAddress: str(fd, "legalAddress"),
        companyNumber: str(fd, "companyNumber"),
        contactEmail: str(fd, "contactEmail"),
        contactPhone: str(fd, "contactPhone"),
        whatsappUrl: str(fd, "whatsappUrl"),
        websiteUrl: str(fd, "websiteUrl"),
        brandPrimary: str(fd, "brandPrimary"),
        brandInk: str(fd, "brandInk"),
        logoUrl: str(fd, "logoUrl"),
        timezone: str(fd, "timezone"),
        holdMinutes: num(fd, "holdMinutes"),
        reminderHoursBefore: num(fd, "reminderHoursBefore"),
        retentionMonths: num(fd, "retentionMonths"),
      },
      { confirm: fd.getAll("confirm").map(String) },
    );
    return "Organisation details saved.";
  });
}

// ---------- venues and rooms ----------

export async function createVenueAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/settings"), async ({ db, user }) => {
    const { venue } = await createVenue(db, user, { name: str(fd, "name") ?? "" });
    return {
      message: `${venue.name} added with one room. Fill in its details, then set it to open.`,
      to: `/admin/settings/venues/${venue.id}`,
    };
  });
}

function hoursFrom(fd: FormData): OpeningHours {
  const out = {} as OpeningHours;
  for (const key of WEEKDAY_KEYS) {
    out[key] = bool(fd, `${key}.closed`) ? null : { open: str(fd, `${key}.open`) ?? "", close: str(fd, `${key}.close`) ?? "" };
  }
  return out;
}

/** Used with <ActionForm>: an error keeps everything typed. */
export async function saveVenueAction(_prev: FormActionState, fd: FormData): Promise<FormActionState> {
  const venueId = str(fd, "venueId") ?? "";
  return runAdminFormAction(backPath(fd, `/admin/settings/venues/${venueId}`), async ({ db, user }) => {
    const org = await getOrganisation(db);
    const opensDate = str(fd, "opensAtDate")?.trim();
    const opensTime = str(fd, "opensAtTime")?.trim() || "10:00";
    const v = await updateVenue(db, user, venueId, {
      name: str(fd, "name"),
      status: str(fd, "status") as "open" | "opening" | "closed",
      opensAt: opensDate ? zonedDateTime(opensDate, opensTime, org.timezone) : null,
      address: str(fd, "address"),
      postcode: str(fd, "postcode"),
      mapsUrl: str(fd, "mapsUrl"),
      parkingNotes: str(fd, "parkingNotes"),
      transportNotes: str(fd, "transportNotes"),
      googleCalendarId: str(fd, "googleCalendarId"),
      openingHours: hoursFrom(fd),
      openingHoursConfirmed: bool(fd, "openingHoursConfirmed"),
      maxPlacesPerBooking: num(fd, "maxPlacesPerBooking"),
      defaultLeadTimeMinutes: hoursToMinutes(fd, "defaultLeadTimeHours"),
      defaultCutoffMinutes: num(fd, "defaultCutoffMinutes"),
      sortOrder: num(fd, "sortOrder"),
    });
    return `${v.name} saved.`;
  });
}

export async function addRoomAction(fd: FormData): Promise<void> {
  const venueId = str(fd, "venueId") ?? "";
  await runAdminAction(backPath(fd, `/admin/settings/venues/${venueId}#rooms`), async ({ db, user }) => {
    const r = await addRoom(db, user, venueId, { name: str(fd, "name") ?? "" });
    return `${r.name} added.`;
  });
}

export async function renameRoomAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/settings"), async ({ db, user }) => {
    const r = await renameRoom(db, user, str(fd, "roomId") ?? "", { name: str(fd, "name") ?? "" });
    return `Renamed to ${r.name}.`;
  });
}

export async function deleteRoomAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/settings"), async ({ db, user }) => {
    await deleteRoom(db, user, str(fd, "roomId") ?? "");
    return "Room removed.";
  });
}

// ---------- terms and waiver ----------

export async function saveLegalAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/settings/terms"), async ({ db, user }) => {
    const doc = str(fd, "doc") === "waiver" ? "waiver" : "terms";
    const newVersion = str(fd, "mode") === "new_version";
    const org = await saveLegalText(db, user, { doc, text: str(fd, "text") ?? "", newVersion });
    const version = doc === "terms" ? org.termsVersion : org.waiverVersion;
    const name = doc === "terms" ? "Terms" : "Waiver";
    return newVersion ? `${name} saved as version ${version}.` : `${name} wording saved (still version ${version}).`;
  });
}

// ---------- email templates ----------

export async function saveTemplateAction(fd: FormData): Promise<void> {
  const key = str(fd, "key") ?? "";
  await runAdminAction(backPath(fd, `/admin/settings/emails/${key}`), async ({ db, user }) => {
    await saveEmailTemplate(db, user, key, { subject: str(fd, "subject") ?? "", body: str(fd, "body") ?? "" });
    return "Email saved. New emails use it straight away.";
  });
}

export async function resetTemplateAction(fd: FormData): Promise<void> {
  const key = str(fd, "key") ?? "";
  await runAdminAction(backPath(fd, `/admin/settings/emails/${key}`), async ({ db, user }) => {
    await resetEmailTemplate(db, user, key);
    return "Back to the default wording.";
  });
}

export type PreviewResult = { ok: true; subject: string; html: string } | { ok: false; error: string };

/** Render unsaved template text with a sample booking, for the preview pane. */
export async function previewEmailAction(key: string, subject: string, body: string): Promise<PreviewResult> {
  const user = await requireUser();
  try {
    assertOwner(user);
    if (!isTemplateKey(key)) return { ok: false, error: "That email template does not exist." };
    const db = await getDb();
    const org = await getOrganisation(db);
    const r = await previewTemplate(db, org.id, key, { subject: String(subject).slice(0, 300), body: String(body).slice(0, 20_000) });
    return { ok: true, subject: r.subject, html: r.html };
  } catch (e) {
    return { ok: false, error: adminErrorMessage(e) };
  }
}
