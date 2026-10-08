import type { Metadata } from "next";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Button, EmptyState, Field, PageHeader, SectionTitle, Textarea } from "@/components/ui";
import { saveLegalAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Terms and waiver" };

function LegalForm({ doc, title, text, version, placeholder }: { doc: "terms" | "waiver"; title: string; text: string; version: number; placeholder: boolean }) {
  return (
    <section>
      <SectionTitle aside={`Version ${version}`}>
        {title} {placeholder ? <Badge tone="amber">Placeholder: please confirm</Badge> : null}
      </SectionTitle>
      <form action={saveLegalAction} className="rounded-2xl border border-line bg-surface p-4">
        <input type="hidden" name="doc" value={doc} />
        <input type="hidden" name="back" value="/admin/settings/terms" />
        <Field label={`${title} wording`} htmlFor={`legal-${doc}`}>
          <Textarea id={`legal-${doc}`} name="text" defaultValue={text} rows={12} required maxLength={50_000} />
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" name="mode" value="new_version" block>
            Save as new version ({version + 1})
          </Button>
          <Button type="submit" name="mode" value="wording_only" variant="secondary" block>
            Save wording only (typo fix)
          </Button>
        </div>
      </form>
    </section>
  );
}

export default async function TermsPage() {
  const ctx = await getAdminContext();
  if (!ctx.user.isOwner) {
    return (
      <>
        <PageHeader back={{ href: "/admin/settings", label: "Settings" }} title="Terms and waiver" />
        <EmptyState title="Only the owner can change the terms" />
      </>
    );
  }
  const org = ctx.org;
  const pending = new Set(org.placeholdersPending);
  return (
    <>
      <PageHeader
        back={{ href: "/admin/settings", label: "Settings" }}
        title="Terms and waiver"
        subtitle="Customers tick both before paying. New bookings record the version they accepted."
      />
      <LegalForm doc="terms" title="Terms" text={org.termsText} version={org.termsVersion} placeholder={pending.has("termsText")} />
      <LegalForm doc="waiver" title="Waiver" text={org.waiverText} version={org.waiverVersion} placeholder={pending.has("waiverText")} />
    </>
  );
}
