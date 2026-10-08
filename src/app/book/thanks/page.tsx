import { Suspense } from "react";
import { ThanksView } from "./ThanksView";

export default function ThanksPage() {
  return (
    <Suspense fallback={<p className="text-neutral-700">Loading…</p>}>
      <ThanksView />
    </Suspense>
  );
}
