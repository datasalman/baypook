"use client";

import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "../_lib/dates";

/** "We're holding your places for 14:59", counting down to `expiresAt`; calls `onExpire` once. */
export function HoldTimer({ expiresAt, what, onExpire }: { expiresAt: string; what: string; onExpire: () => void }) {
  const end = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => end - Date.now());
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const ms = end - Date.now();
      setLeft(ms);
      if (ms <= 0 && !fired.current) {
        fired.current = true;
        expireRef.current();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [end]);

  const low = left < 2 * 60_000;
  return (
    <div className={`mb-5 rounded-lg border px-4 py-3 ${low ? "border-amber-400 bg-amber-50" : "border-neutral-300 bg-neutral-100"}`}>
      {/* role=timer is not announced every second; the low-time line below is. */}
      <p role="timer" className="font-semibold">
        We&apos;re holding your {what} for <span className="tabular-nums">{formatCountdown(left)}</span>
      </p>
      <p aria-live="polite" className="text-sm text-neutral-800">
        {low && left > 0 ? "Less than two minutes left. Please finish your details." : null}
      </p>
    </div>
  );
}
