import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import * as s from "@/db/schema";
import { fmtLocal } from "@/core/time";
import { isDemo } from "@/lib/env";
import { listOutbox } from "@/server/notifications";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import type { SearchParams } from "../_lib/dates";
import { resendEmail } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Outbox" };

const TEMPLATE_LABEL: Record<string, string> = {
  confirmation: "Confirmation",
  reminder: "Reminder",
  cancellation: "Cancellation",
  refund: "Refund",
  owner_new_party: "New party alert",
  magic_link: "Sign-in link",
};

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "sent", label: "Sent" },
  { value: "demo", label: "Not sent (demo)" },
  { value: "failed", label: "Failed" },
  { value: "queued", label: "Queued" },
];

const SHOW = 100;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function OutboxPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const tz = ctx.org.timezone;
  const q = one(sp.q).trim().slice(0, 100);
  const template = one(sp.template);
  const status = one(sp.status);

  // The owner looking at every venue also sees emails that belong to no venue (sign-in links).
  const venueIds = ctx.user.isOwner && ctx.selectedVenueId === "all" ? null : ctx.selectedVenues.map((v) => v.id);

  // A booking reference finds that booking's emails.
  let bookingId: string | undefined;
  if (/^BP-[A-Z0-9]{3,}$/i.test(q)) {
    const where: SQL[] = [eq(s.bookings.reference, q.toUpperCase())];
    if (venueIds) where.push(inArray(s.bookings.venueId, venueIds.length ? venueIds : ["00000000-0000-0000-0000-000000000000"]));
    const [b] = await ctx.db
      .select({ id: s.bookings.id })
      .from(s.bookings)
      .where(and(...where))
      .limit(1);
    bookingId = b?.id;
  }

  const statusFilter = STATUS_OPTIONS.some((o) => o.value && o.value === status) ? (status as s.Notification["status"]) : undefined;
  const shown = await listOutbox(ctx.db, {
    venueIds,
    limit: SHOW,
    search: bookingId ? undefined : q || undefined,
    bookingId,
    template: template || undefined,
    status: statusFilter,
  });

  const venueName = new Map(ctx.venues.map((v) => [v.id, v.name]));
  const bookingIds = [...new Set(shown.map((r) => r.bookingId).filter((x): x is string => Boolean(x)))];
  const refs = bookingIds.length
    ? await ctx.db.select({ id: s.bookings.id, reference: s.bookings.reference }).from(s.bookings).where(inArray(s.bookings.id, bookingIds))
    : [];
  const refById = new Map(refs.map((r) => [r.id, r.reference]));

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (template) qs.set("template", template);
  if (status) qs.set("status", status);
  const back = `/admin/outbox${qs.size ? `?${qs.toString()}` : ""}`;

  return (
    <>
      <PageHeader title="Outbox" subtitle="Every email BayPook sent, or would have sent, newest first" />
      {isDemo() ? (
        <Banner tone="info" className="mb-4">
          These emails were not sent. In live mode this page still lists everything sent through Resend.
        </Banner>
      ) : null}

      <form method="get" action="/admin/outbox" className="mb-4 rounded-2xl border border-line bg-surface p-3">
        <Field label="Search" htmlFor="q" hint="Email address, subject or booking reference">
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="e.g. BP-7K3M2" />
        </Field>
        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="template">
            <Select
              id="template"
              name="template"
              defaultValue={template}
              options={[{ value: "", label: "Any email" }, ...Object.entries(TEMPLATE_LABEL).map(([value, label]) => ({ value, label }))]}
            />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" name="status" defaultValue={status} options={STATUS_OPTIONS} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Show</Button>
          {qs.size ? (
            <Button href="/admin/outbox" variant="ghost">
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      {shown.length === 0 ? (
        <EmptyState title={qs.size ? "No emails match" : "No emails yet"} />
      ) : (
        <ul className="grid gap-3">
          {shown.map((r) => {
            const ref = r.bookingId ? refById.get(r.bookingId) : undefined;
            return (
              <li key={r.id} className="rounded-2xl border border-line bg-surface">
                <details>
                  <summary className="flex min-h-14 cursor-pointer list-none flex-col gap-1 p-4 [&::-webkit-details-marker]:hidden">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{TEMPLATE_LABEL[r.template] ?? r.template}</span>
                      <Badge status={r.status} />
                    </span>
                    <span className="break-words">{r.subject}</span>
                    <span className="text-sm text-muted">
                      To {r.toAddress} · {fmtLocal(r.createdAt, "EEE d MMM, HH:mm", tz)}
                      {ref ? ` · ${ref}` : ""}
                      {r.venueId && ctx.venues.length > 1 ? ` · ${venueName.get(r.venueId) ?? ""}` : ""}
                    </span>
                    {r.error ? <span className="text-sm font-semibold text-danger">{r.error}</span> : null}
                  </summary>
                  <div className="border-t border-line p-4">
                    <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="font-semibold text-muted">Status</dt>
                      <dd>{r.status}</dd>
                      <dt className="font-semibold text-muted">Provider id</dt>
                      <dd className="break-all font-mono">{r.providerId ?? "None"}</dd>
                      {r.sentAt ? (
                        <>
                          <dt className="font-semibold text-muted">Sent</dt>
                          <dd>{fmtLocal(r.sentAt, "EEE d MMM yyyy, HH:mm:ss", tz)}</dd>
                        </>
                      ) : null}
                      {ref && r.bookingId ? (
                        <>
                          <dt className="font-semibold text-muted">Booking</dt>
                          <dd>
                            <Link href={`/admin/bookings/${r.bookingId}`}>{ref}</Link>
                          </dd>
                        </>
                      ) : null}
                      {r.error ? (
                        <>
                          <dt className="font-semibold text-muted">Error</dt>
                          <dd className="break-words text-danger">{r.error}</dd>
                        </>
                      ) : null}
                    </dl>

                    <iframe
                      title={`Email preview: ${r.subject}`}
                      srcDoc={r.bodyHtml}
                      sandbox=""
                      className="h-96 w-full rounded-xl border border-line bg-white"
                    />

                    {r.attachments.length ? (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {r.attachments.map((a, i) => (
                          <li key={`${a.filename}-${i}`}>
                            <a href={`/admin/outbox/${r.id}/attachment/${i}`} download className="inline-flex min-h-11 items-center rounded-xl border-2 border-line px-3 font-semibold no-underline">
                              Download {a.filename}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <details className="mt-3">
                      <summary className="min-h-11 cursor-pointer py-2 font-semibold">Plain text version</summary>
                      <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-canvas p-3 text-sm">{r.bodyText || "(none)"}</pre>
                    </details>

                    {(r.status === "failed" || r.status === "demo") && r.template !== "magic_link" ? (
                      <form action={resendEmail} className="mt-3">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="back" value={back} />
                        <Button type="submit" variant="secondary">
                          Send again
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {shown.length === SHOW ? <p className="mt-3 text-center text-sm text-muted">Showing the newest {SHOW}. Search to find older emails.</p> : null}
    </>
  );
}
