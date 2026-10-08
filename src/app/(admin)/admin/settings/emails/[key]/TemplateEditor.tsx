"use client";

import { useRef, useState, useTransition } from "react";
import { Button, Field, Input, Textarea } from "@/components/ui";
import type { PreviewResult } from "../../actions";

type Props = {
  templateKey: string;
  subject: string;
  body: string;
  placeholders: { key: string; meaning: string }[];
  saveAction: (fd: FormData) => Promise<void>;
  previewAction: (key: string, subject: string, body: string) => Promise<PreviewResult>;
};

/** Subject + body editor with the placeholder list and a live preview of the unsaved text. */
export function TemplateEditor({ templateKey, subject, body, placeholders, saveAction, previewAction }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const bodyEl = () => formRef.current?.elements.namedItem("body") as HTMLTextAreaElement | null;
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pending, start] = useTransition();

  const runPreview = () => {
    const fd = formRef.current ? new FormData(formRef.current) : null;
    const s = String(fd?.get("subject") ?? "");
    const b = String(fd?.get("body") ?? "");
    start(async () => {
      setPreview(await previewAction(templateKey, s, b));
    });
  };

  const insert = (key: string) => {
    const el = bodyEl();
    if (!el) return;
    const token = `{{${key}}}`;
    const startPos = el.selectionStart ?? el.value.length;
    const endPos = el.selectionEnd ?? el.value.length;
    el.setRangeText(token, startPos, endPos, "end");
    el.focus();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
      <form ref={formRef} action={saveAction} className="min-w-0 rounded-2xl border border-line bg-surface p-4">
        <input type="hidden" name="key" value={templateKey} />
        <input type="hidden" name="back" value={`/admin/settings/emails/${templateKey}`} />
        <Field label="Subject" htmlFor="tpl-subject">
          <Input id="tpl-subject" name="subject" defaultValue={subject} required maxLength={300} />
        </Field>
        <Field
          label="Message"
          htmlFor="tpl-body"
          hint="Lines starting ## are headings. {{#if name}}…{{/if}} keeps a line only when it has a value."
        >
          <Textarea id="tpl-body" name="body" defaultValue={body} rows={18} required maxLength={20_000} className="font-mono text-sm" />
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" block>
            Save email
          </Button>
          <Button type="button" variant="secondary" block onClick={runPreview} disabled={pending}>
            {pending ? "Making preview…" : "Preview"}
          </Button>
        </div>
      </form>

      <aside className="rounded-2xl border border-line bg-surface p-4" aria-label="Placeholders">
        <p className="mb-1 font-bold">Placeholders</p>
        <p className="mb-2 text-sm text-muted">Tap one to put it in the message.</p>
        <ul className="flex flex-col gap-1 text-sm">
          {placeholders.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => insert(p.key)}
                className="min-h-11 w-full rounded-lg px-2 py-1 text-left hover:bg-brand-soft"
              >
                <code className="font-semibold text-brand-strong">{`{{${p.key}}}`}</code>
                <span className="block text-muted">{p.meaning}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {preview ? (
        <section className="lg:col-span-2" aria-live="polite">
          {preview.ok ? (
            <>
              <p className="mb-2 text-sm text-muted">
                Preview with a sample booking. Subject: <span className="font-semibold text-ink">{preview.subject}</span>
              </p>
              <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="h-[36rem] w-full rounded-2xl border border-line bg-white" />
            </>
          ) : (
            <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 font-semibold text-danger">
              {preview.error}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
