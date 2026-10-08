import type { Metadata } from "next";
import Link from "next/link";
import { roleAt } from "@/server/auth";
import { listServicesForVenue } from "@/server/catalogue";
import { TIMEZONES } from "@/server/settings";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, SectionTitle, Select, Textarea } from "@/components/ui";
import { createVenueAction, saveOrganisationAction } from "./actions";
import { BrandColours } from "./_components/BrandColours";
import { fmtMinutes } from "../catalogue/_lib/venue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

const STATUS_LABEL = { open: "Open", opening: "Opening soon", closed: "Closed" } as const;

export default async function SettingsPage() {
  const ctx = await getAdminContext();
  const isOwner = ctx.user.isOwner;
  const managed = ctx.venues.filter((v) => isOwner || roleAt(ctx.user, v.id) === "manager");

  if (!isOwner && managed.length === 0) {
    return (
      <>
        <PageHeader title="Settings" />
        <EmptyState title="Only the owner can change settings">If something here needs changing, ask the owner or your manager.</EmptyState>
      </>
    );
  }

  const servicesByVenue = await Promise.all(managed.map(async (v) => ({ venue: v, services: await listServicesForVenue(ctx.db, v.id) })));
  const org = ctx.org;
  const pending = new Set(org.placeholdersPending);

  const tag = (key: string) =>
    pending.has(key) ? (
      <Badge tone="amber" className="ml-1 align-middle">
        Placeholder: please confirm
      </Badge>
    ) : null;
  const confirmBox = (key: string) =>
    pending.has(key) ? (
      <label className="-mt-2 mb-4 flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="confirm" value={key} className="h-5 w-5 accent-[var(--brand-strong)]" />
        This is correct
      </label>
    ) : null;
  const timezones: string[] = TIMEZONES.includes(org.timezone as (typeof TIMEZONES)[number]) ? [...TIMEZONES] : [org.timezone, ...TIMEZONES];

  return (
    <>
      <PageHeader title="Settings" subtitle={isOwner ? "Organisation, venues, policies, terms and email wording" : "Your venue's details"} />

      {pending.size && isOwner ? (
        <p className="mb-4 rounded-xl border border-warn-line bg-warn-bg px-3 py-2 text-sm font-medium text-warn-ink">
          Some details are still placeholders: look for the amber tags below
          {pending.has("termsText") || pending.has("waiverText") ? ", and in Terms and waiver" : ""}
          {pending.has("openingHours") ? ", and confirm each venue's opening hours" : ""}.
        </p>
      ) : null}

      <SectionTitle>Booking policies</SectionTitle>
      <div className="flex flex-col gap-2">
        {servicesByVenue.map(({ venue, services }) => (
          <Card key={venue.id}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-lg font-bold">{venue.name}</span>
              <Link href={`/admin/settings/venues/${venue.id}`} className="text-sm font-semibold">
                Up to {venue.maxPlacesPerBooking} places per booking ›
              </Link>
            </div>
            {services.length ? (
              <ul className="divide-y divide-line text-sm">
                {services.map((svc) => (
                  <li key={svc.id}>
                    <Link href={`/admin/catalogue/${svc.id}#details`} className="flex min-h-11 items-center justify-between gap-2 py-1 text-ink no-underline">
                      <span className="font-semibold">{svc.name}</span>
                      <span className="text-right text-muted">
                        Notice {fmtMinutes(svc.leadTimeMinutes)} · closes {svc.cutoffMinutes ? `${fmtMinutes(svc.cutoffMinutes)} before` : "at the start"} ›
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No services yet.</p>
            )}
          </Card>
        ))}
      </div>

      <SectionTitle>Venues</SectionTitle>
      <ul className="flex flex-col gap-2">
        {managed.map((v) => (
          <Card key={v.id} as="li" href={`/admin/settings/venues/${v.id}`}>
            <span className="flex items-center justify-between gap-2">
              <span>
                <span className="block font-bold">{v.name}</span>
                <span className="block text-sm text-muted">{v.address || "No address yet"}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <Badge tone={v.status === "open" ? "green" : v.status === "opening" ? "amber" : "grey"}>{STATUS_LABEL[v.status]}</Badge>
                {!v.openingHoursConfirmed ? <Badge tone="amber">Confirm hours</Badge> : null}
              </span>
            </span>
          </Card>
        ))}
      </ul>

      {isOwner ? (
        <>
          <details className="mt-3 rounded-2xl border border-dashed border-line bg-surface p-4">
            <summary className="min-h-11 cursor-pointer font-bold">Add a venue</summary>
            <form action={createVenueAction} className="mt-3">
              <Field label="Venue name" htmlFor="venue-name" hint="It starts closed with one room, Main room, so nothing can be booked until you are ready.">
                <Input id="venue-name" name="name" required maxLength={120} />
              </Field>
              <Button type="submit" block>
                Add venue
              </Button>
            </form>
          </details>

          <SectionTitle>Wording</SectionTitle>
          <div className="grid gap-2 sm:grid-cols-2">
            <Card href="/admin/settings/terms">
              <span className="block font-bold">Terms and waiver {tag("termsText") ?? tag("waiverText")}</span>
              <span className="block text-sm text-muted">
                Terms version {org.termsVersion}, waiver version {org.waiverVersion}
              </span>
            </Card>
            <Card href="/admin/settings/emails">
              <span className="block font-bold">Email templates</span>
              <span className="block text-sm text-muted">Confirmation, reminder, cancellation, refund, party alert</span>
            </Card>
          </div>

          <SectionTitle>Organisation</SectionTitle>
          <form action={saveOrganisationAction} className="rounded-2xl border border-line bg-surface p-4">
            <input type="hidden" name="back" value="/admin/settings" />
            <Field label={<>Business name {tag("name")}</>} htmlFor="org-name">
              <Input id="org-name" name="name" defaultValue={org.name} required maxLength={120} />
            </Field>
            <Field label={<>Tagline {tag("tagline")}</>} htmlFor="org-tagline" optional>
              <Input id="org-tagline" name="tagline" defaultValue={org.tagline ?? ""} maxLength={200} />
            </Field>

            <h3 className="mb-2 mt-2 font-bold">Legal details (on emails and receipts)</h3>
            <Field label={<>Legal name {tag("legalName")}</>} htmlFor="org-legal-name" optional>
              <Input id="org-legal-name" name="legalName" defaultValue={org.legalName ?? ""} maxLength={200} />
            </Field>
            {confirmBox("legalName")}
            <Field label={<>Registered address {tag("legalAddress")}</>} htmlFor="org-legal-address" optional>
              <Textarea id="org-legal-address" name="legalAddress" defaultValue={org.legalAddress ?? ""} rows={3} maxLength={500} />
            </Field>
            {confirmBox("legalAddress")}
            <Field label={<>Company number {tag("companyNumber")}</>} htmlFor="org-company" optional>
              <Input id="org-company" name="companyNumber" defaultValue={org.companyNumber ?? ""} maxLength={100} />
            </Field>
            {confirmBox("companyNumber")}

            <h3 className="mb-2 mt-2 font-bold">Contact</h3>
            <Field label={<>Contact email {tag("contactEmail")}</>} htmlFor="org-email" hint="Customers reply to this address.">
              <Input id="org-email" name="contactEmail" type="email" defaultValue={org.contactEmail} required />
            </Field>
            <div className="grid gap-x-3 sm:grid-cols-2">
              <Field label={<>Phone {tag("contactPhone")}</>} htmlFor="org-phone" optional>
                <Input id="org-phone" name="contactPhone" type="tel" defaultValue={org.contactPhone ?? ""} maxLength={50} />
              </Field>
              <Field label={<>WhatsApp link {tag("whatsappUrl")}</>} htmlFor="org-wa" optional>
                <Input id="org-wa" name="whatsappUrl" type="url" defaultValue={org.whatsappUrl ?? ""} placeholder="https://wa.me/44…" />
              </Field>
              <Field label={<>Website {tag("websiteUrl")}</>} htmlFor="org-web" optional>
                <Input id="org-web" name="websiteUrl" type="url" defaultValue={org.websiteUrl ?? ""} placeholder="https://" />
              </Field>
              <Field label={<>Logo link {tag("logoUrl")}</>} htmlFor="org-logo" optional>
                <Input id="org-logo" name="logoUrl" type="url" defaultValue={org.logoUrl ?? ""} placeholder="https://" />
              </Field>
            </div>

            <h3 className="mb-2 mt-2 font-bold">Branding</h3>
            <BrandColours primary={org.brandPrimary} ink={org.brandInk} name={org.name} primaryTag={tag("brandPrimary")} inkTag={tag("brandInk")} />

            <h3 className="mb-2 mt-2 font-bold">Running</h3>
            <Field label={<>Time zone {tag("timezone")}</>} htmlFor="org-tz" hint="Every time and day is worked out in this zone.">
              <Select id="org-tz" name="timezone" defaultValue={org.timezone} options={timezones.map((z) => ({ value: z, label: z.replace("_", " ") }))} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Hold while paying (min)" htmlFor="org-hold">
                <Input id="org-hold" name="holdMinutes" type="number" inputMode="numeric" min={5} max={60} defaultValue={org.holdMinutes} required />
              </Field>
              <Field label="Reminder (hours before)" htmlFor="org-remind">
                <Input id="org-remind" name="reminderHoursBefore" type="number" inputMode="numeric" min={1} max={168} defaultValue={org.reminderHoursBefore} required />
              </Field>
              <Field label="Keep bookings (months)" htmlFor="org-retention">
                <Input id="org-retention" name="retentionMonths" type="number" inputMode="numeric" min={1} max={120} defaultValue={org.retentionMonths} required />
              </Field>
            </div>
            <p className="mb-3 text-sm text-muted">After the keeping period, customers&apos; names and contact details are removed from old bookings.</p>
            <Button type="submit" block>
              Save organisation
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
