"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { BayPookError, friendlyMessage } from "@/client/client";
import type {
  AddOnRequest,
  HoldRequest,
  HoldResponse,
  LineRequest,
  QuoteRequest,
  Service,
  ServiceKind,
  SessionAvailability,
  SlotStart,
  Venue,
} from "@/client/types";
import { isValidDateStr } from "@/core/time";
import { DayStep } from "./_components/DayStep";
import { DetailsStep } from "./_components/DetailsStep";
import { SessionOptionsStep, SlotOptionsStep } from "./_components/OptionsStep";
import { Progress } from "./_components/Progress";
import { ServiceStep } from "./_components/ServiceStep";
import { TimeStep } from "./_components/TimeStep";
import { Button, Loading, Notice } from "./_components/ui";
import { VenueStep } from "./_components/VenueStep";
import { FIXTURE_ALLOWED, useBookingClient } from "./_lib/useBookingClient";
import { useQuote } from "./_lib/useQuote";

type Step = "venue" | "service" | "day" | "time" | "options" | "details";

const SESSION_ORDER: Step[] = ["venue", "service", "day", "time", "options", "details"];
const SLOT_ORDER: Step[] = ["venue", "service", "day", "options", "time", "details"];

function stepLabels(order: Step[], kind: ServiceKind | undefined): string[] {
  const names: Record<Step, string> = {
    venue: "Venue",
    service: "What",
    day: "Day",
    time: "Time",
    options: kind === "slot" ? "Children and extras" : "Places",
    details: "Your details",
  };
  return order.map((s) => names[s]);
}

/** Loading the catalogue: a network problem says so; anything else gets one plain line. */
function loadMessage(err: unknown): string {
  if (err instanceof BayPookError && (err.code === "NETWORK" || err.code === "RATE_LIMITED")) return friendlyMessage(err);
  return "We could not load the booking options just now. Please try again, or message or call us to book.";
}

/** A hold is reused when the customer steps back and forward without changing anything. */
const HOLD_REUSE_MARGIN_MS = 60_000;

export function BookFlow() {
  const params = useSearchParams();
  // Deep-link parameters are read once; afterwards the page writes the URL itself.
  const initial = useRef({
    venue: params.get("venue"),
    type: params.get("type") === "session" || params.get("type") === "slot" ? (params.get("type") as ServiceKind) : null,
    item: params.get("item"),
    date: params.get("date") && isValidDateStr(params.get("date") as string) ? (params.get("date") as string) : null,
  });
  const fixture = FIXTURE_ALLOWED && params.get("fixture") === "1";
  const holdSeconds = fixture && Number(params.get("hold")) > 0 ? Number(params.get("hold")) : undefined;
  const client = useBookingClient(fixture, holdSeconds);

  const [step, setStep] = useState<Step>("venue");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [initDone, setInitDone] = useState(false);

  const [venues, setVenues] = useState<Venue[] | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [services, setServices] = useState<Service[] | null>(null);
  const [service, setService] = useState<Service | null>(null);
  const [kindFilter, setKindFilter] = useState<ServiceKind | null>(initial.current.type);
  const [date, setDate] = useState<string | null>(initial.current.date);

  const [session, setSession] = useState<SessionAvailability | null>(null);
  const [slotStart, setSlotStart] = useState<SlotStart | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [packageId, setPackageId] = useState("");
  const [addOnQty, setAddOnQty] = useState<Record<string, number>>({});

  const [hold, setHold] = useState<{ key: string; res: HoldResponse } | null>(null);
  const [holdExpired, setHoldExpired] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [timeFlash, setTimeFlash] = useState<string | null>(null);
  const [timeNonce, setTimeNonce] = useState(0);

  const appliedVenue = useRef(false);
  const appliedItem = useRef(false);

  const chooseService = useCallback((s: Service, keepDate: boolean) => {
    setService(s);
    setQty({});
    setPackageId(s.options[0]?.id ?? "");
    setAddOnQty({});
    setSession(null);
    setSlotStart(null);
    setHold(null);
    setHoldError(null);
    setTimeFlash(null);
    if (!keepDate) setDate(null);
    setStep("day");
  }, []);

  // Venues, then the deep-linked venue.
  useEffect(() => {
    if (!client) return;
    let live = true;
    setLoadError(null);
    client
      .venues()
      .then((vs) => {
        if (!live) return;
        setVenues(vs);
        if (!appliedVenue.current) {
          appliedVenue.current = true;
          const v = vs.find((x) => x.slug === initial.current.venue && x.onlineBookable);
          if (v) {
            setVenue(v);
            setStep("service");
          } else {
            setInitDone(true);
          }
        }
      })
      .catch((err: unknown) => {
        if (live) setLoadError(loadMessage(err));
      });
    return () => {
      live = false;
    };
  }, [client, reload]);

  // Services for the chosen venue, then the deep-linked item.
  useEffect(() => {
    if (!client || !venue) return;
    let live = true;
    setServices(null);
    setLoadError(null);
    client
      .services(venue.slug)
      .then((ss) => {
        if (!live) return;
        setServices(ss);
        if (!appliedItem.current) {
          appliedItem.current = true;
          const { item, type } = initial.current;
          const s = ss.find((x) => x.slug === item && (!type || x.kind === type));
          if (s) chooseService(s, true);
          setInitDone(true);
        }
      })
      .catch((err: unknown) => {
        if (live) setLoadError(loadMessage(err));
      });
    return () => {
      live = false;
    };
  }, [client, venue, reload, chooseService]);

  // Keep the URL shareable: venue, type, item and date.
  useEffect(() => {
    if (!initDone) return;
    const p = new URLSearchParams();
    if (venue) p.set("venue", venue.slug);
    if (service) {
      p.set("type", service.kind);
      p.set("item", service.slug);
      if (date) p.set("date", date);
    } else if (kindFilter) {
      p.set("type", kindFilter);
    }
    if (fixture) p.set("fixture", "1");
    if (holdSeconds) p.set("hold", String(holdSeconds));
    const qs = p.toString();
    const url = qs ? `/book?${qs}` : "/book";
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, "", url);
  }, [initDone, venue, service, date, kindFilter, fixture, holdSeconds]);

  // Move focus to the new step's heading (not on first load) so screen readers follow along.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    document.getElementById("step-heading")?.focus();
  }, [step]);

  const order = service?.kind === "slot" ? SLOT_ORDER : SESSION_ORDER;
  const back = () => {
    const i = order.indexOf(step);
    if (i > 0) setStep(order[i - 1]);
  };

  const selection = useMemo((): { lines: LineRequest[]; addOns: AddOnRequest[] } | null => {
    if (!service) return null;
    if (service.kind === "session") {
      const lines = service.options.map((o) => ({ optionId: o.id, qty: qty[o.id] ?? 0 })).filter((l) => l.qty > 0);
      return lines.length ? { lines, addOns: [] } : null;
    }
    if (!packageId) return null;
    return {
      lines: [{ optionId: packageId, qty: 1 }],
      addOns: service.addOns.map((a) => ({ addOnId: a.id, qty: addOnQty[a.id] ?? 0 })).filter((a) => a.qty > 0),
    };
  }, [service, qty, packageId, addOnQty]);

  const extraMinutes = useMemo(() => {
    if (!service || service.kind !== "slot") return 0;
    return service.addOns.filter((a) => a.kind === "time").reduce((sum, a) => sum + a.extraMinutes * (addOnQty[a.id] ?? 0), 0);
  }, [service, addOnQty]);

  const quoteRequest: QuoteRequest | null =
    step === "options" && venue && service && selection ? { venue: venue.slug, service: service.id, ...selection } : null;
  const quote = useQuote(client, quoteRequest);

  async function placeHold(target: { sessionId?: string; startsAt?: string }) {
    if (!client || !venue || !service || !selection) return;
    const req: HoldRequest = { venue: venue.slug, service: service.id, ...selection, ...target };
    const key = JSON.stringify(req);
    if (hold && hold.key === key && new Date(hold.res.hold.expiresAt).getTime() - Date.now() > HOLD_REUSE_MARGIN_MS) {
      setHoldExpired(false);
      setStep("details");
      return;
    }
    setHoldBusy(true);
    setHoldError(null);
    setTimeFlash(null);
    try {
      const res = await client.createHold(req);
      setHold({ key, res });
      setHoldExpired(false);
      setStep("details");
    } catch (err) {
      const message = friendlyMessage(err);
      if (err instanceof BayPookError && err.code === "GONE") {
        setTimeFlash(message);
        setSession(null);
        setSlotStart(null);
        setTimeNonce((n) => n + 1);
        setStep("time");
      } else if (service.kind === "session") {
        setHoldError(message);
      } else {
        setTimeFlash(message);
      }
    } finally {
      setHoldBusy(false);
    }
  }

  // ---------------------------------------------------------------------------

  let content: ReactNode;
  if (!client || (!venues && !loadError)) {
    content = <Loading>Loading…</Loading>;
  } else if (loadError) {
    content = (
      <Notice kind="error">
        <p>{loadError}</p>
        <Button variant="secondary" className="mt-3" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </Notice>
    );
  } else if (step === "venue" || !venue) {
    content = (
      <VenueStep
        venues={venues ?? []}
        selected={venue?.slug ?? null}
        onSelect={(v) => {
          if (v.slug !== venue?.slug) {
            setVenue(v);
            setService(null);
            setHold(null);
          }
          setStep("service");
        }}
      />
    );
  } else if (step === "service" || !service) {
    content = services ? (
      <ServiceStep
        venueName={venue.name}
        services={services}
        kindFilter={kindFilter}
        selected={service?.id ?? null}
        onSelect={(s) => (s.id === service?.id ? setStep("day") : chooseService(s, false))}
        onClearFilter={() => setKindFilter(null)}
        onBack={() => setStep("venue")}
      />
    ) : (
      <Loading>Loading what you can book…</Loading>
    );
  } else if (step === "day" || !date) {
    content = (
      <DayStep
        key={`${service.id}`}
        client={client}
        venue={venue}
        service={service}
        initialDate={date}
        onBack={() => setStep("service")}
        onContinue={(d) => {
          if (d !== date) {
            setSession(null);
            setSlotStart(null);
          }
          setDate(d);
          setTimeFlash(null);
          setStep(service.kind === "slot" ? "options" : "time");
        }}
      />
    );
  } else if (step === "time") {
    content = (
      <TimeStep
        key={`${date}-${timeNonce}`}
        client={client}
        venue={venue}
        service={service}
        date={date}
        extraMinutes={extraMinutes}
        selectedId={service.kind === "slot" ? (slotStart?.startsAt ?? null) : (session?.id ?? null)}
        flash={timeFlash}
        busy={holdBusy}
        backLabel={service.kind === "slot" ? "Change children and extras" : "Change day"}
        onBack={back}
        onSelectSession={(s) => {
          const places = Object.values(qty).reduce((a, b) => a + b, 0);
          if (places > s.remaining) setQty({});
          setSession(s);
          setHoldError(null);
          setTimeFlash(null);
          setStep("options");
        }}
        onSelectSlot={(s) => {
          setSlotStart(s);
          void placeHold({ startsAt: s.startsAt });
        }}
      />
    );
  } else if (step === "options") {
    content =
      service.kind === "session" ? (
        session ? (
          <SessionOptionsStep
            service={service}
            session={session}
            date={date}
            tz={venue.timezone}
            qty={qty}
            onQty={(id, v) => {
              setHoldError(null);
              setQty((q) => ({ ...q, [id]: v }));
            }}
            quote={quote}
            busy={holdBusy}
            error={holdError}
            onBack={back}
            onContinue={() => void placeHold({ sessionId: session.id })}
          />
        ) : (
          <Loading />
        )
      ) : (
        <SlotOptionsStep
          service={service}
          date={date}
          packageId={packageId}
          onPackage={setPackageId}
          addOnQty={addOnQty}
          onAddOn={(id, v) => setAddOnQty((q) => ({ ...q, [id]: v }))}
          quote={quote}
          onBack={back}
          onContinue={() => {
            setTimeFlash(null);
            setStep("time");
          }}
        />
      );
  } else {
    content = hold ? (
      <DetailsStep
        client={client}
        venue={venue}
        service={service}
        hold={hold.res}
        expired={holdExpired}
        onExpire={() => setHoldExpired(true)}
        onChooseAgain={() => {
          setHold(null);
          setHoldExpired(false);
          setSession(null);
          setSlotStart(null);
          setTimeNonce((n) => n + 1);
          setStep("time");
        }}
        onBack={back}
      />
    ) : (
      <Loading />
    );
  }

  const stepIndex = order.indexOf(step);

  return (
    <div>
      {fixture ? (
        <p className="mb-4 rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <strong>Fixture mode (development only).</strong> Sample data from <code>src/app/book/_lib/fixture.ts</code>. Nothing is
          booked, charged or emailed.
        </p>
      ) : null}
      {client && venues ? <Progress labels={stepLabels(order, service?.kind)} current={stepIndex} /> : null}
      {content}
    </div>
  );
}
