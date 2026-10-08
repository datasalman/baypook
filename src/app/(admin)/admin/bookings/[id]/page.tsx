import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import { fmtDayLong, fmtLocal, fmtPence, fmtTime } from "@/core/time";
import { canAccessVenue, canRefund } from "@/server/auth";
import { getBookingDetail } from "@/server/bookings";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, Button, ConfirmButton, EmptyState, Field, Input, PageHeader, SectionTitle, Textarea } from "@/components/ui";
import { withFlash } from "@/components/ui/flash";
import { Disclosure, Facts } from "../_components/Disclosure";
import {
  LEDGER_METHOD_LABEL,
  PAYMENT_METHOD_LABEL,
  SOURCE_LABEL,
  customerName,
  hasRealEmail,
  humaniseAction,
  outstandingPence,
  overpaidPence,
  poundsValue,
  refundablePence,
} from "../_lib/labels";
import {
  cancelBookingAction,
  markPaidAction,
  noShowAction,
  refundBookingAction,
  resendConfirmationAction,
  saveNoteAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Booking" };

const TEMPLATE_LABEL: Record<string, string> = {
  confirmation: "Confirmation",
  reminder: "Reminder",
  cancellation: "Cancellation",
  refund: "Refund",
  owner_new_party: "New party alert (owner)",
  owner_alert: "Alert (owner)",
};

function Hidden({ id }: { id: string }) {
  return <input type="hidden" name="bookingId" value={id} />;
}

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAdminContext();
  const detail = await getBookingDetail(ctx.db, id);
  // Same answer for "missing" and "another venue's", so ids cannot be probed.
  if (!detail || !canAccessVenue(ctx.user, detail.booking.venueId)) {
    redirect(withFlash("/admin/bookings", "We could not find that booking, or it belongs to another venue.", "error"));
  }

  const tz = ctx.org.timezone;
  const { booking: b, customer, service, venue, room, payments, refunds, notifications, calendarLog } = detail;
  const now = new Date();

  const optionIds = b.lines.map((l) => l.optionId);
  const userIds = Array.from(
    new Set([b.createdBy, ...payments.map((p) => p.createdBy), ...refunds.map((r) => r.createdBy)].filter((x): x is string => Boolean(x))),
  );
  const [options, auditRows, users] = await Promise.all([
    optionIds.length ? ctx.db.select().from(s.serviceOptions).where(inArray(s.serviceOptions.id, optionIds)) : Promise.resolve([]),
    ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entityType, "booking"), eq(s.auditLog.entityId, b.id)))
      .orderBy(desc(s.auditLog.createdAt))
      .limit(100),
    userIds.length ? ctx.db.select({ id: s.users.id, name: s.users.name, email: s.users.email }).from(s.users).where(inArray(s.users.id, userIds)) : Promise.resolve([]),
  ]);
  const who = (uid: string | null) => {
    if (!uid) return null;
    const u = users.find((x) => x.id === uid);
    return u ? u.name || u.email : null;
  };

  const isSlot = service.kind === "slot";
  const live = b.status === "confirmed";
  const refundable = refundablePence(b);
  const owed = outstandingPence(b);
  const overpaid = overpaidPence(b);
  const mayRefund = canRefund(ctx.user, b.venueId);
  const realEmail = hasRealEmail(customer.email);
  const started = now.getTime() >= b.startsAt.getTime();
  const hasOnline = payments.some((p) => p.method === "online_card" && p.status !== "pending" && p.status !== "failed");

  const notes: string[] = [];
  const pushNote = (n: string | null | undefined) => {
    const t = n?.trim();
    if (t && !notes.includes(t)) notes.push(t);
  };
  for (const l of b.lines) {
    if (l.qty <= 0) continue;
    const o = options.find((x) => x.id === l.optionId);
    pushNote(o?.inStoreNoteLine ?? o?.inStoreNoteShort);
  }
  pushNote(service.inStoreNoteLine ?? service.inStoreNoteShort);

  const ledger = [
    ...payments.map((p) => ({
      key: `p-${p.id}`,
      at: p.createdAt,
      label: `Payment · ${LEDGER_METHOD_LABEL[p.method]}`,
      amount: p.amountPence,
      status: p.status,
      by: who(p.createdBy),
      note: p.disputeId ? "Disputed with the card provider" : null,
    })),
    ...refunds.map((r) => ({
      key: `r-${r.id}`,
      at: r.createdAt,
      label: "Refund",
      amount: -r.amountPence,
      status: r.status,
      by: who(r.createdBy),
      note: r.reason || null,
    })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());

  return (
    <>
      <PageHeader
        back={{ href: "/admin/bookings", label: "Bookings" }}
        title={b.reference}
        subtitle={`${service.name} · ${venue.name} · ${room.name}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge status={b.status} />
            <Badge status={b.paymentStatus} />
          </div>
        }
      />

      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-lg font-bold">{fmtDayLong(b.startsAt, tz)}</p>
        <p className="text-lg tabular-nums">
          {fmtTime(b.startsAt, tz)}–{fmtTime(b.endsAt, tz)}
        </p>
        <p className="mt-1">
          {isSlot ? `${b.places} children` : `${b.places} ${b.places === 1 ? "place" : "places"}`}
          {b.sessionId ? (
            <>
              {" · "}
              <a href={`/admin/sessions/${b.sessionId}`} className="font-semibold text-brand-strong">
                See the session
              </a>
            </>
          ) : null}
        </p>
        {b.status === "cancelled" ? (
          <p className="mt-2 text-sm text-muted">
            Cancelled{b.cancelledAt ? ` ${fmtLocal(b.cancelledAt, "d MMM yyyy, HH:mm", tz)}` : ""}
            {b.cancelReason ? `: ${b.cancelReason}` : ""}
          </p>
        ) : null}
      </div>

      {owed > 0 ? (
        <Banner className="mt-3">To collect in store: {fmtPence(owed)}</Banner>
      ) : null}
      {overpaid > 0 ? (
        <Banner tone="info" className="mt-3">
          They have paid {fmtPence(overpaid)} more than the total. {mayRefund ? `Give a refund of ${fmtPence(overpaid)}?` : "Ask a manager for a refund."}
        </Banner>
      ) : null}

      {/* ---------- actions ---------- */}
      <section aria-label="Actions" className="mt-4 flex flex-col gap-2">
        {owed > 0 && live ? (
          <Disclosure label="Mark paid in store" variant="primary" open>
            <form action={markPaidAction}>
              <Hidden id={b.id} />
              <fieldset className="mb-4">
                <legend className="mb-2 font-semibold">How did they pay?</legend>
                <label className="flex min-h-12 items-center gap-3">
                  <input type="radio" name="method" value="card_machine" defaultChecked className="h-5 w-5 accent-[var(--brand-strong)]" />
                  Card machine
                </label>
                <label className="flex min-h-12 items-center gap-3">
                  <input type="radio" name="method" value="cash" className="h-5 w-5 accent-[var(--brand-strong)]" />
                  Cash
                </label>
              </fieldset>
              <Field label="Amount taken (£)" htmlFor="paid-amount">
                <Input id="paid-amount" name="amount" inputMode="decimal" defaultValue={poundsValue(owed)} required />
              </Field>
              <Button type="submit" size="lg" block>
                Save payment
              </Button>
            </form>
          </Disclosure>
        ) : null}

        {live ? (
          <>
            <Button href={`/admin/bookings/${b.id}/move`} variant="secondary" size="lg" block>
              Move to another {isSlot ? "time" : "session"}
            </Button>
            <Button href={`/admin/bookings/${b.id}/change`} variant="secondary" size="lg" block>
              Change places or extras
            </Button>
          </>
        ) : null}

        {refundable > 0 && b.status !== "pending" && mayRefund ? (
          <Disclosure label="Give a refund">
            <form action={refundBookingAction}>
              <Hidden id={b.id} />
              <p className="mb-3 text-sm text-muted">
                Up to {fmtPence(refundable)} can be refunded.{" "}
                {hasOnline ? "Card payments go back to the card." : "Give the money back over the counter; this records it."}
              </p>
              <Field label="Amount (£)" htmlFor="refund-amount">
                <Input id="refund-amount" name="amount" inputMode="decimal" defaultValue={poundsValue(overpaid > 0 ? overpaid : refundable)} required />
              </Field>
              <Field label="Reason" htmlFor="refund-reason" optional>
                <Input id="refund-reason" name="reason" maxLength={500} />
              </Field>
              <ConfirmButton block size="lg" prompt="Give this refund now? It cannot be undone." confirmLabel="Yes, give the refund">
                Give the refund
              </ConfirmButton>
            </form>
          </Disclosure>
        ) : null}

        {b.status === "confirmed" || b.status === "pending" ? (
          <Disclosure label="Cancel booking" variant="secondary">
            <form action={cancelBookingAction}>
              <Hidden id={b.id} />
              <Field label="Reason" htmlFor="cancel-reason" hint="Shown in the booking history, not sent to the parent.">
                <Input id="cancel-reason" name="reason" maxLength={500} />
              </Field>
              {refundable > 0 && mayRefund ? (
                <fieldset className="mb-4">
                  <legend className="mb-2 font-semibold">Refund</legend>
                  <label className="flex min-h-12 items-center gap-3">
                    <input type="radio" name="refund" value="none" defaultChecked className="h-5 w-5 accent-[var(--brand-strong)]" />
                    No refund
                  </label>
                  <label className="flex min-h-12 items-center gap-3">
                    <input type="radio" name="refund" value="full" className="h-5 w-5 accent-[var(--brand-strong)]" />
                    Full refund {fmtPence(refundable)}
                  </label>
                  <label className="flex min-h-12 items-center gap-3">
                    <input type="radio" name="refund" value="part" className="h-5 w-5 accent-[var(--brand-strong)]" />
                    Part refund
                  </label>
                  <Field label="Part refund amount (£)" htmlFor="cancel-part" className="ml-8 mt-1" hint="Only used with Part refund.">
                    <Input id="cancel-part" name="partAmount" inputMode="decimal" />
                  </Field>
                </fieldset>
              ) : refundable > 0 ? (
                <p className="mb-4 text-sm text-muted">Ask a manager for refunds.</p>
              ) : null}
              <ConfirmButton
                block
                size="lg"
                prompt={
                  b.status === "pending"
                    ? "Cancel this unpaid booking?"
                    : realEmail
                      ? "Cancel this booking? The parent is emailed."
                      : "Cancel this booking?"
                }
                confirmLabel="Yes, cancel it"
              >
                {refundable > 0 && !mayRefund ? "Cancel without refund" : "Cancel booking"}
              </ConfirmButton>
            </form>
          </Disclosure>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {live && started ? (
            <form action={noShowAction}>
              <Hidden id={b.id} />
              <Button type="submit" variant="secondary" size="lg">
                Mark no-show
              </Button>
            </form>
          ) : null}
          {b.status === "no_show" ? (
            <form action={noShowAction}>
              <Hidden id={b.id} />
              <input type="hidden" name="undo" value="1" />
              <Button type="submit" variant="secondary" size="lg">
                Undo no-show
              </Button>
            </form>
          ) : null}
          {(live || b.status === "no_show") && realEmail ? (
            <form action={resendConfirmationAction}>
              <Hidden id={b.id} />
              <Button type="submit" variant="secondary" size="lg">
                Resend confirmation
              </Button>
            </form>
          ) : null}
        </div>
      </section>

      {/* ---------- parent ---------- */}
      <SectionTitle>Parent</SectionTitle>
      <Facts
        rows={[
          [
            "Name",
            <a key="n" href={`/admin/customers/${customer.id}`} className="text-brand-strong">
              {customerName(customer)}
            </a>,
          ],
          [
            "Phone",
            customer.phone ? (
              <a key="p" href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`} className="text-brand-strong">
                {customer.phone}
              </a>
            ) : (
              "Not given"
            ),
          ],
          [
            "Email",
            realEmail ? (
              <a key="e" href={`mailto:${customer.email}`} className="text-brand-strong">
                {customer.email}
              </a>
            ) : (
              "No email (walk-in)"
            ),
          ],
        ]}
      />
      {customer.notes ? <p className="mt-2 text-sm">Customer note: {customer.notes}</p> : null}

      {/* ---------- what was booked ---------- */}
      <SectionTitle>What was booked</SectionTitle>
      <div className="rounded-2xl border border-line bg-surface p-4">
        <ul className="space-y-1">
          {b.lines.map((l) => (
            <li key={l.optionId} className="flex justify-between gap-2">
              <span>
                {l.qty} × {l.name}
                {l.includedChildren ? <span className="text-muted"> (includes {l.includedChildren} children)</span> : null}
              </span>
              <span className="tabular-nums">{fmtPence(l.totalPence)}</span>
            </li>
          ))}
          {b.addOns.map((a) => (
            <li key={a.addOnId} className="flex justify-between gap-2">
              <span>
                {a.qty} × {a.name}
                {a.kind === "time" && a.extraMinutes ? <span className="text-muted"> (+{a.extraMinutes} min)</span> : null}
              </span>
              <span className="tabular-nums">{fmtPence(a.totalPence)}</span>
            </li>
          ))}
        </ul>
        {notes.length ? (
          <div className="mt-3 border-t border-line pt-3 text-sm">
            <p className="font-semibold">In store</p>
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : null}
        {isSlot && (b.birthdayChildFirstName || b.birthdayChildAge) ? (
          <p className="mt-3 border-t border-line pt-3">
            Birthday child: <strong>{b.birthdayChildFirstName ?? "not given"}</strong>
            {b.birthdayChildAge ? `, turning ${b.birthdayChildAge}` : ""}
          </p>
        ) : null}
        {b.customerMessage ? (
          <div className="mt-3 border-t border-line pt-3">
            <p className="text-sm font-semibold">Message from the parent</p>
            <p className="whitespace-pre-wrap">{b.customerMessage}</p>
          </div>
        ) : null}
        <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
          {SOURCE_LABEL[b.source]}
          {who(b.createdBy) ? ` (${who(b.createdBy)})` : ""} on {fmtLocal(b.createdAt, "d MMM yyyy 'at' HH:mm", tz)}
          {b.termsVersion ? ` · terms v${b.termsVersion}, waiver v${b.waiverVersion ?? "?"}` : ""}
        </p>
      </div>

      {/* ---------- money ---------- */}
      <SectionTitle>Money</SectionTitle>
      <Facts
        rows={[
          ["Total", fmtPence(b.totalPence)],
          ["Paid", fmtPence(b.paidPence)],
          ["Refunded", fmtPence(b.refundedPence)],
          ["Still to pay", fmtPence(owed)],
          ["Payment method", PAYMENT_METHOD_LABEL[b.paymentMethod]],
        ]}
      />
      {ledger.length ? (
        <ul className="mt-2 divide-y divide-line rounded-2xl border border-line bg-surface">
          {ledger.map((e) => (
            <li key={e.key} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{e.label}</p>
                <p className="text-sm text-muted">
                  {fmtLocal(e.at, "d MMM yyyy, HH:mm", tz)}
                  {e.by ? ` · ${e.by}` : ""}
                </p>
                {e.note ? <p className="text-sm">{e.note}</p> : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-bold tabular-nums">{e.amount < 0 ? `−${fmtPence(-e.amount)}` : fmtPence(e.amount)}</span>
                {e.status !== "succeeded" ? <Badge status={e.status} /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No payments yet.</p>
      )}

      {/* ---------- notes ---------- */}
      <SectionTitle>
        <span id="notes">Notes</span>
      </SectionTitle>
      <form action={saveNoteAction} className="rounded-2xl border border-line bg-surface p-4">
        <Hidden id={b.id} />
        <Field label="Internal notes" htmlFor="booking-notes" hint="Allergies, anything the parent said. Staff only.">
          <Textarea id="booking-notes" name="notes" defaultValue={b.notes ?? ""} maxLength={5000} />
        </Field>
        <Button type="submit">Save notes</Button>
      </form>

      {/* ---------- history ---------- */}
      <SectionTitle>History</SectionTitle>
      <h3 className="mb-1 mt-2 font-semibold">Emails</h3>
      {notifications.length ? (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {notifications.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{TEMPLATE_LABEL[n.template] ?? humaniseAction(n.template)}</p>
                <p className="text-sm text-muted [overflow-wrap:anywhere]">
                  {n.toAddress} · {fmtLocal(n.createdAt, "d MMM, HH:mm", tz)}
                </p>
                {n.error ? <p className="text-sm text-danger">{n.error}</p> : null}
              </div>
              <Badge status={n.status} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No emails yet.</p>
      )}
      {(live || b.status === "no_show") && realEmail ? (
        <form action={resendConfirmationAction} className="mt-2">
          <Hidden id={b.id} />
          <Button type="submit" variant="ghost">
            Resend confirmation
          </Button>
        </form>
      ) : null}

      <h3 className="mb-1 mt-4 font-semibold">Calendar</h3>
      {calendarLog.length ? (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {calendarLog.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{c.action === "create" ? "Added" : c.action === "update" ? "Updated" : "Removed"}</p>
                <p className="text-sm text-muted">{fmtLocal(c.createdAt, "d MMM, HH:mm", tz)}</p>
                {c.error ? <p className="text-sm text-danger">{c.error}</p> : null}
              </div>
              <Badge status={c.status === "ok" ? "sent" : c.status} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing pushed to the calendar yet.</p>
      )}

      <h3 className="mb-1 mt-4 font-semibold">Changes</h3>
      {auditRows.length ? (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {auditRows.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <p className="font-semibold">{humaniseAction(a.action)}</p>
              <p className="text-sm text-muted">
                {fmtLocal(a.createdAt, "d MMM yyyy, HH:mm", tz)} · {a.actor}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No changes recorded" />
      )}
    </>
  );
}
