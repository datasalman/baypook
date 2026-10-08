import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold leading-tight text-center no-underline select-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-contrast hover:brightness-95 active:brightness-90 shadow-sm",
  secondary: "bg-surface text-ink border-2 border-line hover:border-ink/40 active:bg-canvas",
  danger: "bg-danger text-white hover:brightness-95 active:brightness-90 shadow-sm",
  ghost: "bg-transparent text-brand-strong hover:bg-brand-soft active:bg-brand-soft",
};

// Every size keeps at least a 44px target.
const sizes: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 text-sm",
  md: "min-h-12 px-4 text-base",
  lg: "min-h-14 px-5 text-lg",
};

export function buttonClasses(opts: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
  return cn(base, variants[opts.variant ?? "primary"], sizes[opts.size ?? "md"], opts.block && "w-full", opts.className);
}

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  className?: string;
  children: ReactNode;
};

export type ButtonProps = CommonProps &
  (
    | ({ href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">)
    | { href: string; prefetch?: boolean; "aria-label"?: string; title?: string; disabled?: boolean }
  );

/** A button, or a link styled as one when `href` is given. */
export function Button(props: ButtonProps) {
  const { variant, size, block, className, children } = props;
  const classes = buttonClasses({ variant, size, block, className });
  if (props.href !== undefined) {
    const { href, prefetch, title, disabled } = props;
    return (
      <Link
        href={href}
        prefetch={prefetch}
        title={title}
        aria-label={props["aria-label"]}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        className={classes}
      >
        {children}
      </Link>
    );
  }
  const { variant: _v, size: _s, block: _b, className: _c, children: _ch, href: _h, type, ...rest } = props;
  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
}
