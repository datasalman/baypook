"use client";

import { useActionState, useState } from "react";
import { Banner, Button, Field, Input, Select, useSubmitWithoutReset } from "@/components/ui";
import type { InviteState } from "./actions";

export type InviteFormProps = {
  action: (prev: InviteState, formData: FormData) => Promise<InviteState>;
  venues: { id: string; name: string }[];
};

export function InviteForm({ action, venues }: InviteFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [role, setRole] = useState("staff");
  // Remount the inputs after a successful invite so the form clears.
  const formKey = state?.ok ? `done-${state.email}` : "form";
  // Submitting from onSubmit skips React's form reset, so an error keeps what was typed
  // (the values also come back in the state, for the no-JavaScript post).
  const onSubmit = useSubmitWithoutReset(formAction);
  const typed = state && !state.ok ? state.values : undefined;

  return (
    <div>
      {state ? (
        <Banner tone={state.ok ? "info" : "danger"} className="mb-3">
          <p>{state.message}</p>
          {state.link ? (
            <p className="mt-1 break-all">
              <a href={state.link}>{state.link}</a>
            </p>
          ) : null}
        </Banner>
      ) : null}
      <form key={formKey} action={formAction} onSubmit={onSubmit}>
        <Field label="Email" htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" autoComplete="off" required defaultValue={typed?.email} />
        </Field>
        <Field label="Name" htmlFor="invite-name">
          <Input id="invite-name" name="name" autoComplete="off" required maxLength={120} defaultValue={typed?.name} />
        </Field>
        <Field
          label="Role"
          htmlFor="invite-role"
          hint="Owner: everything at every venue. Manager: one venue, can give refunds. Staff: one venue, no refunds."
        >
          <Select
            id="invite-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: "staff", label: "Staff" },
              { value: "manager", label: "Manager" },
              { value: "owner", label: "Owner" },
            ]}
          />
        </Field>
        {role !== "owner" ? (
          <Field label="Venue" htmlFor="invite-venue">
            <Select id="invite-venue" name="venueId" required defaultValue={typed?.venueId || (venues.length === 1 ? venues[0].id : "")}>
              <option value="" disabled>
                Choose a venue
              </option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Button type="submit" disabled={pending} block>
          {pending ? "Sending…" : "Send invite"}
        </Button>
      </form>
    </div>
  );
}
