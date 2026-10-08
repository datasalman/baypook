process.env.BAYPOOK_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import * as s from "@/db/schema";
import { loadUser, type CurrentUser } from "@/server/auth";
import { inviteUser, listUsers, roleSummary, setUserActive, updateUser, UsersAdminError } from "@/server/users-admin";

let db: Db;
let sw: string;
let lk: string;
let owner: CurrentUser;
let manager: CurrentUser;

async function userByEmail(email: string): Promise<CurrentUser> {
  const [u] = await db.select().from(s.users).where(eq(s.users.email, email));
  const loaded = await loadUser(db, u.id);
  if (!loaded) throw new Error(`no user ${email}`);
  return loaded;
}

async function expectCode(p: Promise<unknown>, code: UsersAdminError["code"]) {
  await expect(p).rejects.toBeInstanceOf(UsersAdminError);
  await p.catch((e: UsersAdminError) => expect(e.code).toBe(code));
}

beforeAll(async () => {
  db = await createTestDb({ seed: true });
  const venues = await db.select().from(s.venues);
  sw = venues.find((v) => v.slug === "south-woodford")!.id;
  lk = venues.find((v) => v.slug === "lakeside")!.id;
  owner = await userByEmail("owner@demo.baypook");
  manager = await userByEmail("manager.southwoodford@demo.baypook");
});

describe("inviteUser", () => {
  it("creates the user and venue role, emails a link and returns it in demo mode", async () => {
    const r = await inviteUser(db, { by: owner, email: " New.Staff@Example.com ", name: "New Staff", isOwner: false, venues: [{ venueId: lk, role: "staff" }] });
    expect(r.user.email).toBe("new.staff@example.com");
    expect(r.user.active).toBe(true);
    expect(r.user.invitedBy).toBe(owner.id);
    expect(r.link).toMatch(/\/auth\/magic\?token=/);

    const roles = await db.select().from(s.userVenues).where(eq(s.userVenues.userId, r.user.id));
    expect(roles).toEqual([{ userId: r.user.id, venueId: lk, role: "staff" }]);

    const mail = await db.select().from(s.notifications).where(eq(s.notifications.toAddress, "new.staff@example.com"));
    expect(mail.length).toBe(1);

    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, r.user.id));
    expect(log.map((l) => l.action)).toContain("user.invite");

    const listed = (await listUsers(db)).find((u) => u.id === r.user.id)!;
    expect(roleSummary(listed)).toBe("Staff at Lakeside");
  });

  it("refuses duplicates, missing venues and non-owners", async () => {
    await expectCode(inviteUser(db, { by: owner, email: "owner@demo.baypook", name: "X", isOwner: false, venues: [{ venueId: sw, role: "staff" }] }), "EXISTS");
    await expectCode(inviteUser(db, { by: owner, email: "a@example.com", name: "A", isOwner: false, venues: [] }), "INVALID");
    await expectCode(inviteUser(db, { by: owner, email: "not-an-email", name: "A", isOwner: true, venues: [] }), "INVALID");
    await expectCode(inviteUser(db, { by: manager, email: "b@example.com", name: "B", isOwner: true, venues: [] }), "FORBIDDEN");
  });

  it("invites an owner without venues", async () => {
    const r = await inviteUser(db, { by: owner, email: "second.owner@example.com", name: "Second owner", isOwner: true, venues: [{ venueId: sw, role: "staff" }] });
    expect(r.user.isOwner).toBe(true);
    expect(await db.select().from(s.userVenues).where(eq(s.userVenues.userId, r.user.id))).toEqual([]);
    // Tidy up: turn this owner off again so the next tests start with one owner.
    await setUserActive(db, { by: owner, userId: r.user.id, active: false });
  });
});

describe("owner safety", () => {
  it("cannot remove or deactivate the last owner, nor deactivate yourself", async () => {
    const [{ id: secondOwnerId }] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, "second.owner@example.com"));
    // The only active owner is the demo owner.
    await expectCode(updateUser(db, { by: owner, userId: owner.id, name: "Demo owner", isOwner: false, venues: [{ venueId: sw, role: "manager" }] }), "SELF");
    await expectCode(setUserActive(db, { by: owner, userId: owner.id, active: false }), "SELF");

    // Bring the second owner back, let them try to demote the first: allowed only while two owners exist.
    await setUserActive(db, { by: owner, userId: secondOwnerId, active: true });
    const second = (await loadUser(db, secondOwnerId))!;
    await updateUser(db, { by: second, userId: owner.id, name: "Demo owner", isOwner: false, venues: [{ venueId: sw, role: "manager" }] });
    const demoted = (await loadUser(db, owner.id))!;
    expect(demoted.isOwner).toBe(false);
    expect(demoted.venues).toEqual([{ venueId: sw, role: "manager" }]);

    // Now `second` is the last owner: nobody can remove them.
    const firstAgainOwner = { ...second };
    await expectCode(setUserActive(db, { by: firstAgainOwner, userId: secondOwnerId, active: false }), "SELF");
    await expectCode(updateUser(db, { by: second, userId: secondOwnerId, name: "Second owner", isOwner: false, venues: [{ venueId: lk, role: "staff" }] }), "SELF");

    // Restore the demo owner, then the last-owner rule applies across users.
    await updateUser(db, { by: second, userId: owner.id, name: "Demo owner", isOwner: true, venues: [] });
    const restored = (await loadUser(db, owner.id))!;
    await setUserActive(db, { by: restored, userId: secondOwnerId, active: false });
    // Only the demo owner is left: a (hypothetical) other owner session cannot demote them.
    await expectCode(updateUser(db, { by: second, userId: owner.id, name: "Demo owner", isOwner: false, venues: [{ venueId: sw, role: "manager" }] }), "LAST_OWNER");
  });

  it("deactivating signs the user out and is audited; reactivating works", async () => {
    await db.insert(s.sessionsAuth).values({ userId: manager.id, tokenHash: "x", expiresAt: new Date(Date.now() + 3600_000) });
    await setUserActive(db, { by: owner, userId: manager.id, active: false });
    expect(await loadUser(db, manager.id)).toBeNull();
    expect(await db.select().from(s.sessionsAuth).where(eq(s.sessionsAuth.userId, manager.id))).toEqual([]);
    await setUserActive(db, { by: owner, userId: manager.id, active: true });
    expect((await loadUser(db, manager.id))?.email).toBe(manager.email);
    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, manager.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["user.deactivate", "user.reactivate"]));
  });
});
