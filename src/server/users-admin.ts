/**
 * Users and invites (owner only). Users are never deleted: they are
 * deactivated, and every change is written to the audit log.
 *
 * Rules: only owners manage users; a user cannot deactivate themselves or
 * change their own role; the last active owner can never lose owner rights or
 * be deactivated; managers and staff need at least one venue.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import * as s from "@/db/schema";
import { normaliseEmail, requestMagicLink, type CurrentUser, type VenueRole } from "./auth";
import { audit } from "./audit";

export type UsersAdminErrorCode = "FORBIDDEN" | "INVALID" | "EXISTS" | "NOT_FOUND" | "LAST_OWNER" | "SELF";

export class UsersAdminError extends Error {
  readonly code: UsersAdminErrorCode;
  constructor(code: UsersAdminErrorCode, message: string) {
    super(message);
    this.name = "UsersAdminError";
    this.code = code;
  }
}

export type VenueRoleInput = { venueId: string; role: VenueRole };

export type UserRow = {
  id: string;
  email: string;
  name: string;
  isOwner: boolean;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  venues: { venueId: string; venueName: string; role: VenueRole }[];
};

const ROLE_WORD: Record<VenueRole, string> = { manager: "Manager", staff: "Staff" };

/** "Owner", or "Manager at South Woodford; Staff at Lakeside", or "No venue". */
export function roleSummary(u: Pick<UserRow, "isOwner" | "venues">): string {
  if (u.isOwner) return "Owner";
  if (!u.venues.length) return "No venue";
  return u.venues.map((v) => `${ROLE_WORD[v.role]} at ${v.venueName}`).join("; ");
}

function requireOwnerUser(by: CurrentUser): void {
  if (!by.isOwner) throw new UsersAdminError("FORBIDDEN", "Only the owner can manage users.");
}

/** Every user with their venue roles: active first, then by name. */
export async function listUsers(db: DbOrTx): Promise<UserRow[]> {
  const [users, roles] = await Promise.all([
    db.select().from(s.users).orderBy(asc(s.users.name), asc(s.users.email)),
    db
      .select({ userId: s.userVenues.userId, venueId: s.userVenues.venueId, role: s.userVenues.role, venueName: s.venues.name, sort: s.venues.sortOrder })
      .from(s.userVenues)
      .innerJoin(s.venues, eq(s.userVenues.venueId, s.venues.id))
      .orderBy(asc(s.venues.sortOrder), asc(s.venues.name)),
  ]);
  return users
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isOwner: u.isOwner,
      active: u.active,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      venues: roles.filter((r) => r.userId === u.id).map((r) => ({ venueId: r.venueId, venueName: r.venueName, role: r.role })),
    }))
    .sort((a, b) => Number(b.active) - Number(a.active));
}

async function activeOwnerCount(db: DbOrTx, excludingUserId?: string): Promise<number> {
  const where = [eq(s.users.isOwner, true), eq(s.users.active, true)];
  if (excludingUserId) where.push(ne(s.users.id, excludingUserId));
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.users)
    .where(and(...where));
  return Number(n);
}

/** Validate and de-duplicate venue roles against real venues. */
async function cleanVenueRoles(db: DbOrTx, isOwner: boolean, venues: VenueRoleInput[]): Promise<VenueRoleInput[]> {
  if (isOwner) return [];
  const seen = new Map<string, VenueRole>();
  for (const v of venues) {
    if (v.role !== "manager" && v.role !== "staff") throw new UsersAdminError("INVALID", "Choose manager or staff.");
    if (v.venueId) seen.set(v.venueId, v.role);
  }
  if (!seen.size) throw new UsersAdminError("INVALID", "Managers and staff need a venue.");
  const ids = [...seen.keys()];
  const found = await db.select({ id: s.venues.id }).from(s.venues).where(inArray(s.venues.id, ids));
  if (found.length !== ids.length) throw new UsersAdminError("INVALID", "That venue does not exist.");
  return ids.map((venueId) => ({ venueId, role: seen.get(venueId)! }));
}

function snapshot(u: Pick<s.User, "email" | "name" | "isOwner" | "active">, venues: VenueRoleInput[]) {
  return { email: u.email, name: u.name, isOwner: u.isOwner, active: u.active, venues };
}

async function loadRow(db: DbOrTx, userId: string): Promise<{ user: s.User; venues: VenueRoleInput[] }> {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
  if (!user) throw new UsersAdminError("NOT_FOUND", "That user does not exist.");
  const venues = await db
    .select({ venueId: s.userVenues.venueId, role: s.userVenues.role })
    .from(s.userVenues)
    .where(eq(s.userVenues.userId, userId));
  return { user, venues };
}

export type InviteInput = {
  by: CurrentUser;
  email: string;
  name: string;
  isOwner: boolean;
  venues: VenueRoleInput[];
};

/**
 * Create an active user with their venue roles and email them a sign-in link.
 * In demo mode the link is returned so the page can show it.
 */
export async function inviteUser(db: Db, input: InviteInput): Promise<{ user: s.User; link?: string }> {
  requireOwnerUser(input.by);
  const email = normaliseEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UsersAdminError("INVALID", "Enter a valid email address.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new UsersAdminError("INVALID", "Enter their name.");
  const venues = await cleanVenueRoles(db, input.isOwner, input.venues);

  const [existing] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email)).limit(1);
  if (existing) throw new UsersAdminError("EXISTS", "Someone with that email already has a login. Edit them below.");

  const user = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(s.users)
      .values({ email, name, isOwner: input.isOwner, active: true, invitedBy: input.by.id })
      .returning();
    if (venues.length) await tx.insert(s.userVenues).values(venues.map((v) => ({ userId: u.id, ...v })));
    await audit(tx, {
      user: input.by,
      action: "user.invite",
      entityType: "user",
      entityId: u.id,
      venueId: venues.length === 1 ? venues[0].venueId : null,
      after: snapshot(u, venues),
    });
    return u;
  });

  const sent = await requestMagicLink(db, email);
  return sent.link ? { user, link: sent.link } : { user };
}

/** Send a fresh sign-in link to an active user. Returns the link in demo mode. */
export async function resendInvite(db: Db, input: { by: CurrentUser; userId: string }): Promise<{ link?: string }> {
  requireOwnerUser(input.by);
  const { user } = await loadRow(db, input.userId);
  if (!user.active) throw new UsersAdminError("INVALID", "Turn their login back on first.");
  const sent = await requestMagicLink(db, user.email);
  await audit(db, { user: input.by, action: "user.send_link", entityType: "user", entityId: user.id });
  return sent.link ? { link: sent.link } : {};
}

export type UpdateUserInput = {
  by: CurrentUser;
  userId: string;
  name: string;
  isOwner: boolean;
  venues: VenueRoleInput[];
};

/** Change a user's name, owner flag and venue roles. */
export async function updateUser(db: Db, input: UpdateUserInput): Promise<void> {
  requireOwnerUser(input.by);
  const before = await loadRow(db, input.userId);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new UsersAdminError("INVALID", "Enter their name.");
  const venues = await cleanVenueRoles(db, input.isOwner, input.venues);
  const key = (list: VenueRoleInput[]) =>
    JSON.stringify([...list].sort((a, b) => a.venueId.localeCompare(b.venueId)).map((v) => [v.venueId, v.role]));
  const roleChanged = before.user.isOwner !== input.isOwner || (!input.isOwner && key(before.venues) !== key(venues));
  if (roleChanged && input.userId === input.by.id) {
    throw new UsersAdminError("SELF", "You cannot change your own role. Ask another owner.");
  }
  if (before.user.isOwner && !input.isOwner && before.user.active && (await activeOwnerCount(db, input.userId)) === 0) {
    throw new UsersAdminError("LAST_OWNER", "There must always be at least one owner.");
  }

  await db.transaction(async (tx) => {
    await tx.update(s.users).set({ name, isOwner: input.isOwner, updatedAt: new Date() }).where(eq(s.users.id, input.userId));
    await tx.delete(s.userVenues).where(eq(s.userVenues.userId, input.userId));
    if (venues.length) await tx.insert(s.userVenues).values(venues.map((v) => ({ userId: input.userId, ...v })));
    await audit(tx, {
      user: input.by,
      action: "user.update",
      entityType: "user",
      entityId: input.userId,
      before: snapshot(before.user, before.venues),
      after: snapshot({ ...before.user, name, isOwner: input.isOwner }, venues),
    });
  });
}

/** Turn a login off (signs them out everywhere) or back on. Never deletes. */
export async function setUserActive(db: Db, input: { by: CurrentUser; userId: string; active: boolean }): Promise<void> {
  requireOwnerUser(input.by);
  const before = await loadRow(db, input.userId);
  if (before.user.active === input.active) return;
  if (!input.active) {
    if (input.userId === input.by.id) throw new UsersAdminError("SELF", "You cannot turn off your own login.");
    if (before.user.isOwner && (await activeOwnerCount(db, input.userId)) === 0) {
      throw new UsersAdminError("LAST_OWNER", "There must always be at least one owner.");
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(s.users).set({ active: input.active, updatedAt: new Date() }).where(eq(s.users.id, input.userId));
    if (!input.active) await tx.delete(s.sessionsAuth).where(eq(s.sessionsAuth.userId, input.userId));
    await audit(tx, {
      user: input.by,
      action: input.active ? "user.reactivate" : "user.deactivate",
      entityType: "user",
      entityId: input.userId,
      before: { active: before.user.active },
      after: { active: input.active },
    });
  });
}
