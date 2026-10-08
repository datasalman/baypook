"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { FLASH_KIND_PARAM, FLASH_PARAM, type FlashKind } from "./flash";

export type ToastProps = {
  kind?: FlashKind;
  children: ReactNode;
  onClose?: () => void;
};

/** A message pinned above the bottom nav. */
export function Toast({ kind = "success", children, onClose }: ToastProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
      <div
        role={kind === "error" ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-base font-semibold shadow-lg",
          kind === "error" ? "bg-danger text-white" : "bg-ink text-white",
        )}
      >
        <span className="min-w-0 flex-1">{children}</span>
        {onClose ? (
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-white/80 hover:text-white" aria-label="Dismiss">
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shows `?flash=` once, then removes it from the URL. Render inside <Suspense>
 * (it reads search params). The admin layout already does this.
 */
export function FlashToast({ durationMs = 6000 }: { durationMs?: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const message = params.get(FLASH_PARAM);
  const kind: FlashKind = params.get(FLASH_KIND_PARAM) === "error" ? "error" : "success";
  const [shown, setShown] = useState<{ message: string; kind: FlashKind } | null>(null);

  useEffect(() => {
    if (!message) return;
    setShown({ message, kind });
    const next = new URLSearchParams(params.toString());
    next.delete(FLASH_PARAM);
    next.delete(FLASH_KIND_PARAM);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [message, kind, params, pathname, router]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), durationMs);
    return () => clearTimeout(t);
  }, [shown, durationMs]);

  if (!shown) return null;
  return (
    <Toast kind={shown.kind} onClose={() => setShown(null)}>
      {shown.message}
    </Toast>
  );
}
