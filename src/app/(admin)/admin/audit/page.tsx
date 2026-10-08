import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import * as s from "@/db/schema";
import { fmtLocal } from "@/core/time";
import { roleAt } from "@/server/auth";
import { listAudit } from "@/server/audit";
import { getAdminContext } from "@/server/venue-scope";
import { Button, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import type { SearchParams } from "../_lib/dates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

const SHOW = 200;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function pretty(v: unknown): string {
  if (v === null || v === undefined) return "(nothing)";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** "booking.cancel" -> "Booking cancel" */
function humanise(action: string): string {
  const t = action.replace(/[._]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;

  // Owners see everything; managers see their venues' rows; staff cannot see the log.
  const managed = ctx.selectedVenues.filter((v) => roleAt(ctx.user, v.id) === "manager").map((v) => v.id);
  if (!ctx.user.isOwner && !ctx.user.venues.some((v) => v.role === "manager")) {
    return (
      <>
        <PageHeader title="Audit log" />
        <EmptyState title="Only the owner and managers can see this page" />
      </>
    );
  }
  const scope = ctx.user.isOwner
    ? ctx.selectedVenueId === "all"
      ? { venueIds: null, includeOrgWide: true }
      : { venueIds: ctx.selectedVenues.map((v) => v.id), includeOrgWide: true }
    : { venueIds: managed, includeOrgWide: false };

  const q = one(sp.q).trim().slice(0, 100);
  const type = one(sp.type);
  const [all, typeRows] = await Promise.all([
    listAudit(ctx.db, { ...scope, search: q || undefined, limit: type ? 1000 : SHOW }),
    ctx.db.selectDistinct({ t: s.auditLog.entityType }).from(s.auditLog).orderBy(asc(s.auditLog.entityType)),
  ]);
  const rows = (type ? all.filter((r) => r.entityType === type) : all).slice(0, SHOW);
  const venueName = new Map(ctx.venues.map((v) => [v.id, v.name]));
  const filtered = Boolean(q || type);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, and when. Newest first." />

      <form method="get" action="/admin/audit" className="mb-4 rounded-2xl border border-line bg-surface p-3">
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Field label="Search" htmlFor="q" hint="Who, what they did, or a record id">
            <Input id="q" name="q" type="search" defaultValue={q} />
          </Field>
          <Field label="Record type" htmlFor="type">
            <Select
              id="type"
              name="type"
              defaultValue={type}
              options={[{ value: "", label: "Everything" }, ...typeRows.map((r) => ({ value: r.t, label: humanise(r.t) }))]}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Show</Button>
          {filtered ? (
            <Button href="/admin/audit" variant="ghost">
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={filtered ? "Nothing matches" : "Nothing logged yet"} />
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-2xl border border-line bg-surface">
              <details>
                <summary className="flex min-h-14 cursor-pointer list-none flex-col gap-0.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="font-semibold">{humanise(r.action)}</span>
                  <span className="text-sm text-muted">
                    {fmtLocal(r.createdAt, "EEE d MMM yyyy, HH:mm", tz)} · {r.actor}
                    {r.venueId ? ` · ${venueName.get(r.venueId) ?? "Other venue"}` : ""}
                  </span>
                  <span className="break-all text-sm text-muted">
                    {humanise(r.entityType)}
                    {r.entityId ? ` ${r.entityId}` : ""}
                  </span>
                </summary>
                <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-sm font-semibold text-muted">Before</p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-canvas p-3 text-sm">{pretty(r.before)}</pre>
                  </div>
                  <div>
                    <p className="mb-1 text-sm font-semibold text-muted">After</p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-canvas p-3 text-sm">{pretty(r.after)}</pre>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {rows.length === SHOW ? <p className="mt-3 text-center text-sm text-muted">Showing the newest {SHOW}. Search to find older entries.</p> : null}
    </>
  );
}
