"use client";

import { useEffect, useState } from "react";
import { createBayPookClient, type BayPookClient } from "@/client/client";

/** Same origin: the reference page is served by BayPook itself. The website passes its BayPook URL instead. */
const API_BASE = "";

/** Fixture booking tokens start with this, so the thank-you page knows to stay in fixture mode. */
export const FIXTURE_TOKEN_PREFIX = "fixture_";

/** Fixture mode is for development only; production builds drop the import entirely. */
export const FIXTURE_ALLOWED = process.env.NODE_ENV !== "production";

/**
 * The page's API client. With `fixture` (development only) it is the same client fed by the
 * in-memory sample API in `fixture.ts`, loaded on demand.
 */
export function useBookingClient(fixture: boolean, holdSeconds?: number): BayPookClient | null {
  const useFixture = FIXTURE_ALLOWED && fixture;
  const [client, setClient] = useState<BayPookClient | null>(() => (useFixture ? null : createBayPookClient({ baseUrl: API_BASE })));

  useEffect(() => {
    if (!useFixture) {
      setClient((c) => c ?? createBayPookClient({ baseUrl: API_BASE }));
      return;
    }
    let live = true;
    void import("./fixture").then((m) => {
      if (live) setClient(createBayPookClient({ baseUrl: API_BASE, fetch: m.createFixtureFetch({ holdSeconds }) }));
    });
    return () => {
      live = false;
    };
  }, [useFixture, holdSeconds]);

  return client;
}
