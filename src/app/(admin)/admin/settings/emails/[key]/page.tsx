import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PLACEHOLDERS } from "@/providers/email/defaults";
import { isTemplateKey, listEmailTemplates } from "@/server/settings";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, ConfirmButton, EmptyState, PageHeader } from "@/components/ui";
import { previewEmailAction, resetTemplateAction, saveTemplateAction } from "../../actions";
import { TemplateEditor } from "./TemplateEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit email" };

export default async function EmailTemplatePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const ctx = await getAdminContext();
  if (!isTemplateKey(key)) notFound();
  if (!ctx.user.isOwner) {
    return (
      <>
        <PageHeader back={{ href: "/admin/settings", label: "Settings" }} title="Email templates" />
        <EmptyState title="Only the owner can change email wording" />
      </>
    );
  }
  const t = (await listEmailTemplates(ctx.db, ctx.org.id)).find((x) => x.key === key);
  if (!t) notFound();

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settings/emails", label: "Email templates" }}
        title={t.name}
        actions={t.isDefault ? <Badge tone="grey">Default wording</Badge> : <Badge tone="brand">Edited</Badge>}
      />
      <TemplateEditor
        key={`${t.subject}\n${t.body}`}
        templateKey={t.key}
        subject={t.subject}
        body={t.body}
        placeholders={PLACEHOLDERS}
        saveAction={saveTemplateAction}
        previewAction={previewEmailAction}
      />
      {!t.isDefault ? (
        <form action={resetTemplateAction} className="mt-4">
          <input type="hidden" name="key" value={t.key} />
          <input type="hidden" name="back" value={`/admin/settings/emails/${t.key}`} />
          <ConfirmButton variant="secondary" block prompt="Go back to the default wording? Your changes to this email are lost." confirmLabel="Yes, reset">
            Reset to default
          </ConfirmButton>
        </form>
      ) : null}
    </>
  );
}
