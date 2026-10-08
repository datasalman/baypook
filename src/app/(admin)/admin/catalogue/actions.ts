"use server";

import {
  addExtraSession,
  addTimetableException,
  addTimetableRules,
  cancelSession,
  closeWholeDay,
  createAddOn,
  createBlock,
  createOption,
  createService,
  deleteBlock,
  deleteTimetableException,
  deleteTimetableRule,
  fillTimetableFromOpeningHours,
  moveService,
  restoreSession,
  setAddOnArchived,
  setOptionArchived,
  setServiceArchived,
  setSessionCapacity,
  updateAddOn,
  updateOption,
  updateService,
  updateTimetableRuleCapacity,
  type ExceptionChoice,
} from "@/server/catalogue-admin";
import { backPath, bool, hoursToMinutes, num, optNum, pence, runAdminAction, str } from "./_lib/form";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------- services ----------

export async function createServiceAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const svc = await createService(db, user, {
      venueId: str(fd, "venueId") ?? "",
      kind: str(fd, "kind") as "session" | "slot",
      name: str(fd, "name") ?? "",
      roomId: str(fd, "roomId") ?? "",
      lengthMinutes: num(fd, "lengthMinutes"),
      slotIntervalMinutes: optNum(fd, "slotIntervalMinutes") ?? 30,
      leadTimeMinutes: hoursToMinutes(fd, "leadTimeHours"),
      cutoffMinutes: num(fd, "cutoffMinutes"),
      colour: str(fd, "colour") ?? "#5bbf3a",
      onlineEnabled: false,
    });
    return {
      message: `${svc.name} added. Add its options${svc.kind === "session" ? " and timetable" : ""}, then switch online booking on.`,
      to: `/admin/catalogue/${svc.id}`,
    };
  });
}

export async function updateServiceAction(fd: FormData): Promise<void> {
  const id = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${id}`), async ({ db, user }) => {
    const kind = str(fd, "kind");
    await updateService(db, user, id, {
      name: str(fd, "name"),
      blurb: str(fd, "blurb"),
      roomId: str(fd, "roomId"),
      lengthMinutes: num(fd, "lengthMinutes"),
      ...(kind === "slot" ? { slotIntervalMinutes: num(fd, "slotIntervalMinutes") } : {}),
      leadTimeMinutes: hoursToMinutes(fd, "leadTimeHours"),
      cutoffMinutes: num(fd, "cutoffMinutes"),
      onlineEnabled: bool(fd, "onlineEnabled"),
      payInStoreEnabled: bool(fd, "payInStoreEnabled"),
      inStoreNoteLine: str(fd, "inStoreNoteLine"),
      inStoreNoteShort: str(fd, "inStoreNoteShort"),
      inStoreMenuUrl: str(fd, "inStoreMenuUrl"),
      colour: str(fd, "colour"),
    });
    return "Saved. Changes show on the next availability check.";
  });
}

export async function setServiceArchivedAction(fd: FormData): Promise<void> {
  const id = str(fd, "serviceId") ?? "";
  const archived = str(fd, "archived") === "1";
  await runAdminAction(backPath(fd, `/admin/catalogue/${id}`), async ({ db, user }) => {
    const svc = await setServiceArchived(db, user, id, archived);
    return archived ? `${svc.name} archived. It is hidden from booking.` : `${svc.name} restored.`;
  });
}

export async function moveServiceAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    await moveService(db, user, str(fd, "serviceId") ?? "", str(fd, "direction") === "up" ? "up" : "down");
    return "Order saved.";
  });
}

// ---------- options ----------

function optionInput(fd: FormData) {
  return {
    name: str(fd, "name") ?? "",
    blurb: str(fd, "blurb"),
    unitPricePence: pence(fd, "price"),
    includedChildren: fd.has("includedChildren") ? optNum(fd, "includedChildren") : undefined,
    maxPerBooking: optNum(fd, "maxPerBooking"),
    inStoreNoteLine: str(fd, "inStoreNoteLine"),
    inStoreNoteShort: str(fd, "inStoreNoteShort"),
    inStoreMenuUrl: str(fd, "inStoreMenuUrl"),
  };
}

export async function createOptionAction(fd: FormData): Promise<void> {
  const serviceId = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${serviceId}#options`), async ({ db, user }) => {
    const o = await createOption(db, user, serviceId, optionInput(fd));
    return `${o.name} added.`;
  });
}

export async function updateOptionAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const o = await updateOption(db, user, str(fd, "optionId") ?? "", optionInput(fd));
    return `${o.name} saved.`;
  });
}

export async function setOptionArchivedAction(fd: FormData): Promise<void> {
  const archived = str(fd, "archived") === "1";
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const o = await setOptionArchived(db, user, str(fd, "optionId") ?? "", archived);
    return archived ? `${o.name} archived.` : `${o.name} restored.`;
  });
}

// ---------- add-ons ----------

function addOnInput(fd: FormData) {
  return {
    name: str(fd, "name") ?? "",
    blurb: str(fd, "blurb"),
    pricePence: pence(fd, "price"),
    kind: (str(fd, "kind") === "time" ? "time" : "quantity") as "time" | "quantity",
    extraMinutes: optNum(fd, "extraMinutes") ?? 0,
    maxQuantity: num(fd, "maxQuantity"),
    perChild: bool(fd, "perChild"),
  };
}

export async function createAddOnAction(fd: FormData): Promise<void> {
  const serviceId = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${serviceId}#addons`), async ({ db, user }) => {
    const a = await createAddOn(db, user, serviceId, addOnInput(fd));
    return `${a.name} added.`;
  });
}

export async function updateAddOnAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const a = await updateAddOn(db, user, str(fd, "addOnId") ?? "", addOnInput(fd));
    return `${a.name} saved.`;
  });
}

export async function setAddOnArchivedAction(fd: FormData): Promise<void> {
  const archived = str(fd, "archived") === "1";
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const a = await setAddOnArchived(db, user, str(fd, "addOnId") ?? "", archived);
    return archived ? `${a.name} archived.` : `${a.name} restored.`;
  });
}

// ---------- timetable ----------

export async function addRulesAction(fd: FormData): Promise<void> {
  const serviceId = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${serviceId}#timetable`), async ({ db, user }) => {
    const r = await addTimetableRules(db, user, serviceId, {
      weekdays: fd.getAll("weekdays").map((v) => Number(v)),
      startTime: str(fd, "startTime") ?? "",
      capacity: num(fd, "capacity"),
      validFrom: str(fd, "validFrom") || null,
      validTo: str(fd, "validTo") || null,
    });
    if (!r.added) return "Those times are already in the timetable.";
    return `${plural(r.added, "time", "times")} added.${r.skipped ? ` ${r.skipped} already there.` : ""}`;
  });
}

export async function updateRuleAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const r = await updateTimetableRuleCapacity(db, user, str(fd, "ruleId") ?? "", num(fd, "capacity"));
    return r.message ?? `${r.startTime} now has ${plural(r.capacity, "place", "places")}.`;
  });
}

export async function deleteRuleAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    const d = await deleteTimetableRule(db, user, str(fd, "ruleId") ?? "");
    return d.message ?? "Time removed. Sessions with bookings are kept.";
  });
}

export async function fillRulesAction(fd: FormData): Promise<void> {
  const serviceId = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${serviceId}#timetable`), async ({ db, user }) => {
    const cap = optNum(fd, "capacity");
    const r = await fillTimetableFromOpeningHours(db, user, serviceId, cap === null ? {} : { capacity: cap });
    return r.added ? `${plural(r.added, "time", "times")} added from opening hours.` : "Nothing to add: every hourly time is already there.";
  });
}

// ---------- exceptions ----------

export async function addExceptionAction(fd: FormData): Promise<void> {
  const serviceId = str(fd, "serviceId") ?? "";
  await runAdminAction(backPath(fd, `/admin/catalogue/${serviceId}#changes`), async ({ db, user }) => {
    const r = await addTimetableException(db, user, serviceId, {
      date: str(fd, "date") ?? "",
      kind: str(fd, "kind") as ExceptionChoice,
      startTime: str(fd, "startTime") || null,
      capacity: optNum(fd, "capacity"),
      note: str(fd, "note"),
    });
    return r.message ?? "Saved.";
  });
}

export async function deleteExceptionAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue"), async ({ db, user }) => {
    await deleteTimetableException(db, user, str(fd, "exceptionId") ?? "");
    return "Change removed. The usual timetable applies again.";
  });
}

// ---------- blocks ----------

const REASONS: Record<string, string> = { closed: "Closed", private_hire: "Private hire" };

function bookingsWarning(n: number): string {
  return n ? ` ${plural(n, "booking falls", "bookings fall")} in this time: move or cancel ${n === 1 ? "it" : "them"}.` : "";
}

export async function createBlockAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/blocks"), async ({ db, user }) => {
    const choice = str(fd, "reasonChoice") ?? "other";
    const reason = REASONS[choice] ?? (str(fd, "reasonOther") ?? "").trim();
    const roomId = str(fd, "roomId");
    const r = await createBlock(db, user, {
      venueId: str(fd, "venueId") ?? "",
      roomId: roomId && roomId !== "all" ? roomId : null,
      startDate: str(fd, "startDate") ?? "",
      startTime: str(fd, "startTime") ?? "",
      endDate: str(fd, "endDate") ?? "",
      endTime: str(fd, "endTime") ?? "",
      reason: reason || "",
    });
    return `Time blocked.${bookingsWarning(r.overlappingBookings)}`;
  });
}

export async function closeDayAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/blocks"), async ({ db, user }) => {
    const r = await closeWholeDay(db, user, { venueId: str(fd, "venueId") ?? "", date: str(fd, "date") ?? "", reason: str(fd, "reason") });
    return `Day closed.${bookingsWarning(r.overlappingBookings)}`;
  });
}

export async function deleteBlockAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/blocks"), async ({ db, user }) => {
    await deleteBlock(db, user, str(fd, "blockId") ?? "");
    return "Blocked time removed.";
  });
}

// ---------- single sessions ----------

export async function setSessionCapacityAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/sessions"), async ({ db, user }) => {
    const r = await setSessionCapacity(db, user, str(fd, "sessionId") ?? "", num(fd, "capacity"));
    return `This session now has ${plural(r.capacity, "place", "places")}.`;
  });
}

export async function cancelSessionAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/sessions"), async ({ db, user }) => {
    await cancelSession(db, user, str(fd, "sessionId") ?? "", { bookingsAcknowledged: bool(fd, "acknowledge") });
    return "Session cancelled. It is no longer offered.";
  });
}

export async function restoreSessionAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/sessions"), async ({ db, user }) => {
    await restoreSession(db, user, str(fd, "sessionId") ?? "");
    return "Session back on.";
  });
}

export async function addExtraSessionAction(fd: FormData): Promise<void> {
  await runAdminAction(backPath(fd, "/admin/catalogue/sessions"), async ({ db, user }) => {
    const r = await addExtraSession(db, user, str(fd, "serviceId") ?? "", {
      date: str(fd, "date") ?? "",
      startTime: str(fd, "startTime") ?? "",
      capacity: num(fd, "capacity"),
    });
    return `Extra session added with ${plural(r.capacity, "place", "places")}.`;
  });
}
