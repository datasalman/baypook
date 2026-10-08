import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { fmtDayShort, fmtPence, fmtTime } from "@/core/time";
import { getCustomerWithBookings } from "@/server/customers";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, EmptyState, Field, PageHeader, SectionTitle, Textarea } from "@/components/ui";
import { withFlash } from "@/components/ui/flash";
import { Facts } from "../../bookings/_components/Disclosure";
import { customerName, hasRealEmail } from "../../bookings/_lib/labels";
import { canSeeCustomer, customerVenueScope } from "../_lib/customers";
import { saveCustomerNotesAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAdminContext();
  const data = (await canSeeCustomer(ctx.db, ctx.user, id))
    ? await getCustomerWithBookings(ctx.db, id, { venueIds: customerVenueScope(ctx.user) })
    : null;
  if (!data) redirect(withFlash("/admin/customers", "We could not find that customer.", "error"));

  const tz = ctx.org.timezone;
  const { customer: c, bookings } = data;
  const removed = Boolean(c.anonymisedAt);
  const realEmail = hasRealEmail(c.email);
  const single = ctx.selectedVenues.length === 1 ? ctx.selectedVenues[0] : null;
  const newHref = `/admin/bookings/new?${new URLSearchParams({ customer: c.id, ...(single ? { venue: single.slug } : {}) }).toString()}`;
  const showVenue = ctx.venues.length > 1;
  const live = bookings.filter((b) => b.status === "confirmed" || b.status === "pending");
  const spent = bookings.reduce((n, b) => n + b.paidPence - b.refundedPence, 0);

  return (
    <>
      <PageHeader
        back={{ href: "/admin/customers", label: "Customers" }}
        title={removed ? "Removed customer" : customerName(c)}
        subtitle={`${bookings.length} ${bookings.length === 1 ? "booking" : "bookings"} · ${fmtPence(spent)} paid`}
        actions={
          removed ? null : (
            <Button href={newHref} size="lg">
              New booking for this customer
            </Button>
          )
        }
      />

      {removed ? (
        <EmptyState title="Details removed">This customer&apos;s details were removed under the retention rule.</EmptyState>
      ) : (
        <>
          <Facts
            rows={[
              [
                "Phone",
                c.phone ? (
                  <a key="p" href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="text-brand-strong">
                    {c.phone}
                  </a>
                ) : (
                  "Not given"
                ),
              ],
              [
                "Email",
                realEmail ? (
                  <a key="e" href={`mailto:${c.email}`} className="text-brand-strong">
                    {c.email}
                  </a>
                ) : (
                  "No email"
                ),
              ],
            ]}
          />

          <SectionTitle>Notes</SectionTitle>
          <form action={saveCustomerNotesAction} className="rounded-2xl border border-line bg-surface p-4">
            <input type="hidden" name="customerId" value={c.id} />
            <Field label="About this customer" htmlFor="customer-notes" hint="Allergies, preferences. Staff only; shown on their bookings.">
              <Textarea id="customer-notes" name="notes" defaultValue={c.notes ?? ""} maxLength={5000} />
            </Field>
            <Button type="submit">Save notes</Button>
          </form>
        </>
      )}

      <SectionTitle aside={live.length ? `${live.length} coming up or pending` : undefined}>Bookings</SectionTitle>
      {bookings.length ? (
        <ul className="flex flex-col gap-2">
          {bookings.map((b) => (
            <Card key={b.id} as="li" href={`/admin/bookings/${b.id}`} tone={b.status === "cancelled" ? "muted" : "default"}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-ink">
                    <span className="tabular-nums">
                      {fmtDayShort(b.startsAt, tz)} {fmtTime(b.startsAt, tz)}
                    </span>{" "}
                    <span className="font-semibold">{b.serviceName}</span>
                  </p>
                  <p className="text-sm text-muted">
                    {b.reference}
                    {showVenue ? ` · ${b.venueName}` : ""} · {fmtPence(b.totalPence)}
                  </p>
                </div>
                <Badge status={b.status} />
              </div>
            </Card>
          ))}
        </ul>
      ) : (
        <EmptyState title="No bookings yet" />
      )}
    </>
  );
}
