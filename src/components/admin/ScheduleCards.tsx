import { fmtTime } from "@/core/time";
import { Badge, Card, plural } from "@/components/ui";
import type { BlockItem, PartyItem, ScheduleItem, SessionItem } from "@/app/(admin)/admin/_lib/schedule";

function isFull(i: SessionItem) {
  return i.capacity > 0 && i.taken >= i.capacity;
}

function TimeRange({ start, end, tz }: { start: Date; end: Date; tz: string }) {
  return (
    <span className="tabular-nums">
      {fmtTime(start, tz)}–{fmtTime(end, tz)}
    </span>
  );
}

export function SessionCard({ item, tz, showRoom }: { item: SessionItem; tz: string; showRoom?: boolean }) {
  const full = isFull(item);
  const empty = item.taken === 0;
  return (
    <Card href={`/admin/sessions/${item.id}`} as="li" accent={item.colour} tone={empty ? "muted" : "default"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-bold text-ink">
            <TimeRange start={item.startsAt} end={item.endsAt} tz={tz} /> <span className="font-semibold">{item.serviceName}</span>
          </p>
          <p className="mt-0.5 text-base">
            Places taken{" "}
            <strong className="tabular-nums">
              {item.taken} of {item.capacity}
            </strong>
            {showRoom ? <span className="text-muted"> · {item.roomName}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {item.status === "cancelled" ? <Badge status="cancelled" /> : full ? <Badge status="full" /> : null}
        </div>
      </div>
      {item.parents.length ? <p className="mt-1 text-sm text-muted">{item.parents.join(", ")}</p> : null}
    </Card>
  );
}

function paymentBadge(item: PartyItem) {
  switch (item.paymentStatus) {
    case "paid":
      return <Badge status="paid" />;
    case "owed":
      return <Badge status="owed" />;
    case "refunded":
      return <Badge status="refunded" />;
    case "partially_refunded":
      return <Badge status="partially_refunded" />;
    default:
      return <Badge status="unpaid" />;
  }
}

export function PartyCard({ item, tz, showRoom }: { item: PartyItem; tz: string; showRoom?: boolean }) {
  const child = item.birthdayChildFirstName
    ? `${item.birthdayChildFirstName}${item.birthdayChildAge ? ` (${item.birthdayChildAge})` : ""}`
    : null;
  return (
    <Card href={`/admin/bookings/${item.id}`} as="li" accent={item.colour}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-base font-bold text-ink">
          <TimeRange start={item.startsAt} end={item.endsAt} tz={tz} /> <span className="font-semibold">{item.serviceName}</span>
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {item.status !== "confirmed" ? <Badge status={item.status} /> : null}
          {paymentBadge(item)}
        </div>
      </div>
      <p className="mt-0.5 text-base">
        {child ? (
          <>
            Birthday: <strong>{child}</strong> ·{" "}
          </>
        ) : null}
        <span className="tabular-nums">{plural(item.places, "child", "children")}</span>
        {showRoom ? <span className="text-muted"> · {item.roomName}</span> : null}
      </p>
      <p className="mt-0.5 text-sm text-muted">
        {item.parentName}
        {item.phone ? <span className="tabular-nums"> · {item.phone}</span> : null}
      </p>
    </Card>
  );
}

export function BlockCard({ item, tz }: { item: BlockItem; tz: string }) {
  return (
    <Card as="li" tone="block">
      <p className="text-base font-bold">
        {item.allDay ? "All day" : <TimeRange start={item.startsAt} end={item.endsAt} tz={tz} />} <span className="font-semibold">Blocked</span>
        {item.roomName ? <span className="font-normal"> · {item.roomName}</span> : null}
      </p>
      {item.reason ? <p className="mt-0.5 text-base">{item.reason}</p> : null}
    </Card>
  );
}

export function ScheduleList({ items, tz, showRoom }: { items: ScheduleItem[]; tz: string; showRoom?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it) =>
        it.kind === "session" ? (
          <SessionCard key={`s-${it.id}`} item={it} tz={tz} showRoom={showRoom} />
        ) : it.kind === "party" ? (
          <PartyCard key={`p-${it.id}`} item={it} tz={tz} showRoom={showRoom} />
        ) : (
          <BlockCard key={`b-${it.id}-${it.date}`} item={it} tz={tz} />
        ),
      )}
    </ul>
  );
}
