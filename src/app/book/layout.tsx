import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Book",
  description: "Book a workshop or a party.",
  robots: { index: false },
};

/** Plain, phone-first shell for the reference booking page. Always light, for contrast. */
export default function BookLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-950 [color-scheme:light]">
      <main className="mx-auto max-w-xl px-4 pb-16 pt-6 sm:pt-10">
        <h1 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-700">Book</h1>
        {children}
      </main>
    </div>
  );
}
