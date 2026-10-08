"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Banner } from "./Misc";
import type { FormActionState, FormStateAction } from "./form-state";

export type { FormActionState, FormStateAction };

export type ActionFormProps = {
  /** A server action that redirects on success and returns `{ error }` otherwise. */
  action: FormStateAction;
  children: ReactNode;
  className?: string;
  id?: string;
};

/**
 * An `onSubmit` handler that runs a form action without React's automatic form
 * reset. React 19 resets a form after its action finishes, which also puts
 * controlled radios and checkboxes back to their first state while React state
 * keeps the new one. Submitting inside a transition from `onSubmit` skips that.
 * Keep `action={formAction}` on the form too, for posting without JavaScript.
 */
export function useSubmitWithoutReset(formAction: (formData: FormData) => void): (e: FormEvent<HTMLFormElement>) => void {
  return (e) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const fd = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(fd));
  };
}

/**
 * A form for a server action that keeps everything typed when the action
 * returns an error. React resets a form after its action finishes; submitting
 * from `onSubmit` inside a transition skips that reset, so fields (text, radios,
 * checkboxes, colours) stay as they were and an open <details> stays open.
 * Without JavaScript the same action still runs as a normal form post.
 */
export function ActionForm({ action, children, className, id }: ActionFormProps) {
  const [state, formAction] = useActionState<FormActionState, FormData>(action, { error: null });
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const onSubmit = useSubmitWithoutReset(formAction);

  return (
    <form id={id} action={formAction} onSubmit={onSubmit} className={className}>
      {children}
      {state.error ? (
        <div ref={errorRef} tabIndex={-1} className="mt-3 outline-none">
          <Banner tone="danger">{state.error}</Banner>
        </div>
      ) : null}
    </form>
  );
}
