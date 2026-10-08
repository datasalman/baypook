import type { Metadata } from "next";
import { searchCustomers } from "@/server/customers";
import { getAdminContext } from "@/server/venue-scope";
import { Button, Card, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import type { SearchParams } from "../_lib/dates";
import { customerName, hasRealEmail } from "../bookings/_lib/labels";
import { customerVenueScope } from "./_lib/customers";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customers" };

const SHOW = 50;

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getAdminContext();
  const sp = await searchParams;
  const raw = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const q = (raw ?? "").trim().slice(0, 100);

  // Staff and managers see parents who booked at their venues (filtered in the query, before the limit).
  const list = await searchCustomers(ctx.db, { q: q || undefined, limit: SHOW, venueIds: customerVenueScope(ctx.user) });

  return (
    <>
      <PageHeader title="Customers" subtitle={q ? `Matching “${q}”` : "Most recently updated first"} />
      <form method="get" action="/admin/customers" role="search" className="mb-4 rounded-2xl border border-line bg-surface p-3">
        <Field label="Search" htmlFor="q" hint="Name, phone or email">
          <Input id="q" name="q" type="search" defaultValue={q} autoComplete="off" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Search</Button>
          {q ? (
            <Button href="/admin/customers" variant="secondary">
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      {list.length ? (
        <ul className="flex flex-col gap-2">
          {list.map((c) => (
            <Card key={c.id} as="li" href={`/admin/customers/${c.id}`}>
              <p className="text-base font-bold text-ink">{c.anonymisedAt ? "Removed (retention)" : customerName(c)}</p>
              <p className="text-sm text-muted [overflow-wrap:anywhere]">
                {[c.phone, hasRealEmail(c.email) ? c.email : "No email"].filter(Boolean).join(" · ")}
              </p>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title={q ? "No customers found" : "No customers yet"}>
          {q ? "Try part of the name, or the last few digits of the phone number." : "Customers appear here once they book."}
        </EmptyState>
      )}
      {list.length === SHOW ? <p className="mt-3 text-sm text-muted">Showing the first {SHOW}. Search to narrow it down.</p> : null}
    </>
  );
}
