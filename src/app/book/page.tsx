import { Suspense } from "react";
import { BookFlow } from "./BookFlow";

export default function BookPage() {
  return (
    <Suspense fallback={<p className="text-neutral-700">Loading…</p>}>
      <BookFlow />
    </Suspense>
  );
}
