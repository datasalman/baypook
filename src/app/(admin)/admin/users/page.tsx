import type { Metadata } from "next";
import { fmtLocal } from "@/core/time";
import { listVenues } from "@/server/org";
import { listUsers, roleSummary } from "@/server/users-admin";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Checkbox, ConfirmButton, EmptyState, Field, Input, PageHeader, SectionTitle, Select } from "@/components/ui";
import { InviteForm } from "./InviteForm";
import { inviteAction, sendLinkAction, setActiveAction, updateUserAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Users and invites" };

export default async function UsersPage() {
  const ctx = await getAdminContext();
  if (!ctx.user.isOwner) {
    return (
      <>
        <PageHeader title="Users and invites" />
        <EmptyState title="Only the owner can see this page" />
      </>
    );
  }
  const tz = ctx.org.timezone;
  const [users, venues] = await Promise.all([listUsers(ctx.db), listVenues(ctx.db)]);
  const activeOwners = users.filter((u) => u.isOwner && u.active).length;

  return (
    <>
      <PageHeader title="Users and invites" subtitle="Who can sign in, and what they can do" />

      <ul className="grid gap-3">
        {users.map((u) => {
          const self = u.id === ctx.user.id;
          const lastOwner = u.isOwner && u.active && activeOwners <= 1;
          return (
            <li key={u.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-lg font-bold">
                    {u.name || u.email}
                    {self ? <span className="font-normal text-muted"> (you)</span> : null}
                  </p>
                  <p className="break-all text-sm text-muted">{u.email}</p>
                </div>
                {u.active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Turned off</Badge>}
              </div>
              <p className="mt-1">{roleSummary(u)}</p>
              <p className="text-sm text-muted">
                {u.lastLoginAt ? `Last signed in ${fmtLocal(u.lastLoginAt, "EEE d MMM yyyy, HH:mm", tz)}` : "Has not signed in yet"}
              </p>

              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-strong">Change</summary>
                <form action={updateUserAction} className="mt-2">
                  <input type="hidden" name="userId" value={u.id} />
                  <Field label="Name" htmlFor={`name-${u.id}`}>
                    <Input id={`name-${u.id}`} name="name" defaultValue={u.name} required maxLength={120} />
                  </Field>
                  <Checkbox
                    name="isOwner"
                    defaultChecked={u.isOwner}
                    disabled={self}
                    label="Owner"
                    hint={self ? "You cannot change your own role." : "Everything at every venue. Venue roles below are then ignored."}
                  />
                  {self && u.isOwner ? <input type="hidden" name="isOwner" value="on" /> : null}
                  {venues.map((v) => {
                    const current = u.venues.find((x) => x.venueId === v.id)?.role ?? "";
                    return (
                      <Field key={v.id} label={v.name} htmlFor={`role-${u.id}-${v.id}`}>
                        <Select
                          id={`role-${u.id}-${v.id}`}
                          name={`role_${v.id}`}
                          defaultValue={current}
                          disabled={self}
                          options={[
                            { value: "", label: "No access" },
                            { value: "staff", label: "Staff" },
                            { value: "manager", label: "Manager" },
                          ]}
                        />
                      </Field>
                    );
                  })}
                  {self
                    ? u.venues.map((x) => <input key={x.venueId} type="hidden" name={`role_${x.venueId}`} value={x.role} />)
                    : null}
                  <Button type="submit">Save</Button>
                </form>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                  {u.active ? (
                    <form action={sendLinkAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <Button type="submit" variant="secondary">
                        Send a sign-in link
                      </Button>
                    </form>
                  ) : null}
                  {self || lastOwner ? (
                    <p className="text-sm text-muted">
                      {self ? "You cannot turn off your own login." : "The last owner cannot be turned off."}
                    </p>
                  ) : (
                    <form action={setActiveAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="active" value={u.active ? "0" : "1"} />
                      {u.active ? (
                        <ConfirmButton prompt={`Turn off ${u.name || u.email}'s login? They are signed out straight away.`} confirmLabel="Yes, turn it off">
                          Turn off login
                        </ConfirmButton>
                      ) : (
                        <Button type="submit" variant="secondary">
                          Turn login back on
                        </Button>
                      )}
                    </form>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      <SectionTitle>Invite someone</SectionTitle>
      <div className="rounded-2xl border border-line bg-surface p-4">
        <InviteForm action={inviteAction} venues={venues.map((v) => ({ id: v.id, name: v.name }))} />
      </div>
    </>
  );
}
