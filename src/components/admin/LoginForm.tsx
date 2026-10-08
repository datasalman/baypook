"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button, Field, Input } from "@/components/ui";

export type LoginFormState =
  | { status: "idle" }
  | { status: "sent"; email: string; link?: string }
  | { status: "error"; message: string };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" block disabled={pending}>
      {pending ? "Sending…" : "Email me a sign-in link"}
    </Button>
  );
}

export function LoginForm({
  action,
  next,
}: {
  action: (prev: LoginFormState, formData: FormData) => Promise<LoginFormState>;
  next: string;
}) {
  const [state, formAction] = useActionState(action, { status: "idle" } as LoginFormState);

  if (state.status === "sent") {
    return (
      <div role="status" className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-xl font-bold">Check your email</h2>
        <p className="mt-1">
          If <strong>{state.email}</strong> has an account, a sign-in link is on its way. It works once and lasts 15 minutes.
        </p>
        {state.link ? (
          <div className="mt-3 rounded-xl bg-brand-soft p-3">
            <p className="text-sm font-semibold">Demo mode: here is the link (it is also in the Outbox).</p>
            <a href={state.link} className="mt-1 block break-all text-base font-semibold text-brand-strong underline">
              {state.link}
            </a>
          </div>
        ) : null}
        <form action={formAction} className="mt-3">
          <input type="hidden" name="email" value={state.email} />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" variant="ghost" size="sm">
            Send another link
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="next" value={next} />
      <Field
        label="Your email"
        htmlFor="email"
        error={state.status === "error" ? state.message : undefined}
        hint="We will email you a link. No password needed."
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          autoFocus
          aria-describedby={state.status === "error" ? "email-hint email-error" : "email-hint"}
          invalid={state.status === "error"}
          placeholder="you@example.com"
        />
      </Field>
      <Submit />
    </form>
  );
}
