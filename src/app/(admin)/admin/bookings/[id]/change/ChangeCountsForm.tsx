"use client";

import { useActionState, useCallback, useState } from "react";
import { useFormStatus } from "react-dom";
import type { Quote } from "@/core/pricing";
import { fmtPence } from "@/core/time";
import { Banner, Button } from "@/components/ui";
import { QuantitiesEditor, type EditorCatalogue } from "../../_components/QuantitiesEditor";
import { changeCountsAction, type ChangeCountsState } from "../actions";

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" block disabled={disabled || pending}>
      {pending ? "Saving…" : "Save changes"}
    </Button>
  );
}

export function ChangeCountsForm({
  bookingId,
  catalogue,
  initialLines,
  initialAddOns,
  placesLeft,
  netPaidPence,
}: {
  bookingId: string;
  catalogue: EditorCatalogue;
  initialLines: Record<string, number>;
  initialAddOns: Record<string, number>;
  placesLeft: number | null;
  /** Paid minus refunded so far. */
  netPaidPence: number;
}) {
  const [state, action] = useActionState<ChangeCountsState, FormData>(changeCountsAction, { error: null });
  const [q, setQ] = useState<Quote | null>(null);
  const onQuote = useCallback((next: Quote | null) => setQ(next), []);
  const delta = q ? q.totalPence - netPaidPence : 0;

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <QuantitiesEditor
        catalogue={catalogue}
        initialLines={initialLines}
        initialAddOns={initialAddOns}
        placesLeft={placesLeft}
        onQuote={onQuote}
      />
      <p className="mt-3 text-base" aria-live="polite">
        Paid so far: <strong className="tabular-nums">{fmtPence(netPaidPence)}</strong>
        {q ? (
          delta > 0 ? (
            <>
              {" "}
              · To collect in store: <strong className="tabular-nums">{fmtPence(delta)}</strong>
            </>
          ) : delta < 0 ? (
            <>
              {" "}
              · Give a refund of <strong className="tabular-nums">{fmtPence(-delta)}</strong> after saving
            </>
          ) : (
            " · Nothing more to pay"
          )
        ) : null}
      </p>
      {state.error ? (
        <Banner tone="danger" className="mt-3">
          {state.error}
        </Banner>
      ) : null}
      <div className="mt-4">
        <SaveButton disabled={!q} />
      </div>
    </form>
  );
}
