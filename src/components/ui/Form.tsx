import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "block w-full min-h-12 rounded-xl border-2 border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-brand-strong focus:outline-none focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-brand-strong disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-danger";

export type FieldProps = {
  label: ReactNode;
  /** Id of the control inside; needed for hint/error association. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Shows "(optional)" after the label. */
  optional?: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * Label + control + hint + error. With `htmlFor`, the label points at the
 * control by id; without it, the control is wrapped by the label (still accessible).
 */
export function Field({ label, htmlFor, hint, error, optional, children, className }: FieldProps) {
  const labelText = (
    <span className="mb-1 block text-base font-semibold">
      {label}
      {optional ? <span className="font-normal text-muted"> (optional)</span> : null}
    </span>
  );
  const hintEl = hint ? (
    <span id={htmlFor ? `${htmlFor}-hint` : undefined} className="mt-1 block text-sm text-muted">
      {hint}
    </span>
  ) : null;
  const errorEl = error ? (
    <span id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="mt-1 block text-sm font-semibold text-danger">
      {error}
    </span>
  ) : null;
  if (htmlFor) {
    return (
      <div className={cn("mb-4", className)}>
        <label htmlFor={htmlFor}>{labelText}</label>
        {children}
        {hintEl}
        {errorEl}
      </div>
    );
  }
  return (
    <label className={cn("mb-4 block", className)}>
      {labelText}
      {children}
      {hintEl}
      {errorEl}
    </label>
  );
}

/** aria-describedby for a control inside a Field with `htmlFor`. */
export function describedBy(id: string, opts: { hint?: boolean; error?: boolean }): string | undefined {
  const ids = [opts.hint && `${id}-hint`, opts.error && `${id}-error`].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export function Input({ className, invalid, ...rest }: InputProps) {
  return <input aria-invalid={invalid || undefined} className={cn(control, className)} {...rest} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  options?: { value: string; label: string; disabled?: boolean }[];
};

export function Select({ className, invalid, options, children, ...rest }: SelectProps) {
  return (
    <select aria-invalid={invalid || undefined} className={cn(control, "appearance-auto pr-8", className)} {...rest}>
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export function Textarea({ className, invalid, rows = 4, ...rest }: TextareaProps) {
  return <textarea rows={rows} aria-invalid={invalid || undefined} className={cn(control, "min-h-24", className)} {...rest} />;
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  hint?: ReactNode;
};

/** A checkbox with a large tappable label. */
export function Checkbox({ label, hint, className, ...rest }: CheckboxProps) {
  return (
    <label className={cn("mb-3 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl py-2", className)}>
      <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer accent-[var(--brand-strong)]" {...rest} />
      <span>
        <span className="block text-base font-medium">{label}</span>
        {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
