"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./Button";
import { cn } from "./cn";

export type ConfirmButtonProps = {
  children: ReactNode;
  /** The question shown after the first tap. */
  prompt?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Submitted with the form, like a normal submit button. */
  name?: string;
  value?: string;
  /** Optional server action for this button only (otherwise the form's action). */
  formAction?: (formData: FormData) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
};

/**
 * A submit button that asks "Are you sure?" inline before submitting its form.
 * Use only for money (refunds) and deletion.
 */
export function ConfirmButton({
  children,
  prompt = "Are you sure?",
  confirmLabel = "Yes, do it",
  cancelLabel = "No, go back",
  variant = "danger",
  size = "md",
  block,
  name,
  value,
  formAction,
  disabled,
  className,
}: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  const { pending } = useFormStatus();
  const yesRef = useRef<HTMLButtonElement>(null);

  const wasPending = useRef(false);

  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);

  // Back to the first button once a submit finishes without leaving the page (an error was shown).
  useEffect(() => {
    if (wasPending.current && !pending) setAsking(false);
    wasPending.current = pending;
  }, [pending]);

  if (!asking) {
    return (
      <button
        type="button"
        disabled={disabled || pending}
        className={buttonClasses({ variant, size, block, className })}
        onClick={() => setAsking(true)}
      >
        {children}
      </button>
    );
  }

  return (
    <div role="group" aria-live="polite" className={cn("rounded-xl border-2 border-danger/40 bg-danger-soft p-3", block && "w-full", className)}>
      <p className="mb-2 font-semibold text-ink">{prompt}</p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={yesRef}
          type="submit"
          name={name}
          value={value}
          formAction={formAction}
          disabled={pending}
          className={buttonClasses({ variant, size })}
        >
          {pending ? "Working…" : confirmLabel}
        </button>
        <button type="button" disabled={pending} className={buttonClasses({ variant: "secondary", size })} onClick={() => setAsking(false)}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
