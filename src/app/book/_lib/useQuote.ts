"use client";

import { useEffect, useState } from "react";
import { friendlyMessage, type BayPookClient } from "@/client/client";
import type { Quote, QuoteRequest } from "@/client/types";

export interface QuoteState {
  quote: Quote | null;
  error: string | null;
  /** True until the quote matches the current request. */
  pending: boolean;
}

/** Debounced server quote for the current selection. The page never computes totals itself. */
export function useQuote(client: BayPookClient | null, request: QuoteRequest | null, delayMs = 300): QuoteState {
  const key = request ? JSON.stringify(request) : "";
  const [state, setState] = useState<{ key: string; quote: Quote | null; error: string | null }>({ key: "", quote: null, error: null });

  useEffect(() => {
    if (!key || !client) return;
    let live = true;
    const body = JSON.parse(key) as QuoteRequest;
    const timer = window.setTimeout(() => {
      client
        .quote(body)
        .then((quote) => {
          if (live) setState({ key, quote, error: null });
        })
        .catch((err: unknown) => {
          if (live) setState({ key, quote: null, error: friendlyMessage(err) });
        });
    }, delayMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, key, delayMs]);

  if (!key) return { quote: null, error: null, pending: false };
  const fresh = state.key === key;
  return { quote: state.quote, error: fresh ? state.error : null, pending: !fresh };
}
