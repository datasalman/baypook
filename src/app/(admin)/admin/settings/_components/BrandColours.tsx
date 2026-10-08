"use client";

import { useState, type ReactNode } from "react";
import { contrastOn, contrastRatio } from "@/components/ui/brand";

/** Brand primary + ink colour inputs with a live preview of a button and text. */
export function BrandColours({
  primary,
  ink,
  name,
  primaryTag,
  inkTag,
}: {
  primary: string;
  ink: string;
  name: string;
  primaryTag?: ReactNode;
  inkTag?: ReactNode;
}) {
  const [p, setP] = useState(primary);
  const [i, setI] = useState(ink);
  const fg = contrastOn(p, i);
  const inkOnWhite = contrastRatio(i, "#ffffff");
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-base font-semibold">Brand colour {primaryTag}</span>
          <input
            type="color"
            name="brandPrimary"
            value={p}
            onChange={(e) => setP(e.target.value)}
            className="block h-12 w-full cursor-pointer rounded-xl border-2 border-line bg-surface"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-base font-semibold">Text colour {inkTag}</span>
          <input
            type="color"
            name="brandInk"
            value={i}
            onChange={(e) => setI(e.target.value)}
            className="block h-12 w-full cursor-pointer rounded-xl border-2 border-line bg-surface"
          />
        </label>
      </div>
      <div className="mt-2 rounded-xl border border-line bg-white p-3" aria-label="Colour preview">
        <p className="font-bold" style={{ color: i }}>
          {name || "Your business"}
        </p>
        <p className="text-sm" style={{ color: i }}>
          This is how text and buttons look in emails and the admin.
        </p>
        <span className="mt-2 inline-flex min-h-11 items-center rounded-xl px-4 font-semibold" style={{ backgroundColor: p, color: fg }}>
          Book now
        </span>
      </div>
      {inkOnWhite < 4.5 ? <p className="mt-1 text-sm font-semibold text-danger">The text colour is hard to read on white. Pick a darker one.</p> : null}
    </div>
  );
}
