import type { Metadata } from "next";
import { listEmailTemplates } from "@/server/settings";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email templates" };

const WHEN: Record<string, string> = {
  confirmation: "Sent when a booking is confirmed, with a calendar file",
  reminder: "Sent the day before",
  cancellation: "Sent when a booking is cancelled",
  refund: "Sent when money is refunded",
  owner_new_party: "Sent to you when a party is booked",
};

export default async function EmailsPage() {
  const ctx = await getAdminContext();
  if (!ctx.user.isOwner) {
    return (
      <>
        <PageHeader back={{ href: "/admin/settings", label: "Settings" }} title="Email templates" />
        <EmptyState title="Only the owner can change email wording" />
      </>
    );
  }
  const templates = await listEmailTemplates(ctx.db, ctx.org.id);
  return (
    <>
      <PageHeader back={{ href: "/admin/settings", label: "Settings" }} title="Email templates" subtitle="The wording of every email customers get." />
      <ul className="flex flex-col gap-2">
        {templates.map((t) => (
          <Card key={t.key} as="li" href={`/admin/settings/emails/${t.key}`}>
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block font-bold">{t.name}</span>
                <span className="block text-sm text-muted">{WHEN[t.key] ?? ""}</span>
                <span className="mt-1 block truncate text-sm">Subject: {t.subject}</span>
              </span>
              {t.isDefault ? <Badge tone="grey">Default</Badge> : <Badge tone="brand">Edited</Badge>}
            </span>
          </Card>
        ))}
      </ul>
    </>
  );
}
