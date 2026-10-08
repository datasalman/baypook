/**
 * A tiny, dependency-free template engine for the email bodies in `defaults.ts`.
 *
 * Syntax (owner-editable in Settings):
 *  - `{{key}}`                 replaced by the value (HTML-escaped in HTML, raw in text); missing = ""
 *  - `{{#if key}}…{{/if}}`     kept only when the value is non-empty; inline or across lines
 *  - `## Heading`              a heading line
 *  - blank line                separates paragraphs; other consecutive lines share a paragraph
 *  - a line that is only `{{key}}` whose value has several lines renders as a simple list
 *
 * `renderTemplate` returns bare semantic HTML (`<h2>`, `<p>`, `<a>`, list `<div>`s);
 * `wrapHtml` turns it into a complete, phone-friendly email with inline styles.
 */

export type TemplateVars = Record<string, string | null | undefined>;

export type Brand = { name: string; primary: string; ink: string; footerLines: string[] };

export type RenderedEmail = { subject: string; html: string; text: string };

const IF_BLOCK = /\{\{#if\s+([A-Za-z0-9_]+)\s*\}\}((?:(?!\{\{#if\s)[\s\S])*?)\{\{\/if\}\}/g;
const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const ONLY_VAR_LINE = /^\s*\{\{\s*([A-Za-z0-9_]+)\s*\}\}\s*$/;
/** Marks where a falsy `#if` block was removed, so lines left empty by it can be dropped. */
const GONE = "\u0000";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function valueOf(ctx: TemplateVars, key: string): string {
  const v = ctx[key];
  return v == null ? "" : String(v);
}

function hasValue(ctx: TemplateVars, key: string): boolean {
  return valueOf(ctx, key).trim() !== "";
}

/** Resolve `{{#if}}` blocks (innermost first, so simple nesting works). */
function resolveIfs(source: string, ctx: TemplateVars): string {
  let out = source.replace(/\r\n?/g, "\n");
  for (let guard = 0; guard < 20; guard++) {
    let changed = false;
    out = out.replace(IF_BLOCK, (_m, key: string, inner: string) => {
      changed = true;
      return hasValue(ctx, key) ? inner : GONE;
    });
    if (!changed) break;
  }
  // Drop lines that held nothing but removed blocks; then the markers themselves.
  return out
    .split("\n")
    .filter((line) => !(line.includes(GONE) && line.split(GONE).join("").trim() === ""))
    .map((line) => line.split(GONE).join(""))
    .join("\n");
}

function substituteRaw(line: string, ctx: TemplateVars): string {
  return line.replace(VAR, (_m, key: string) => valueOf(ctx, key));
}

/** Escape, keep line breaks inside a value as <br>, and turn bare URLs into links. */
function substituteHtml(line: string, ctx: TemplateVars): string {
  const parts: string[] = [];
  let last = 0;
  line.replace(VAR, (m: string, key: string, offset: number) => {
    parts.push(escapeHtml(line.slice(last, offset)));
    parts.push(escapeHtml(valueOf(ctx, key)).replace(/\n/g, "<br>"));
    last = offset + m.length;
    return m;
  });
  parts.push(escapeHtml(line.slice(last)));
  return linkify(parts.join(""));
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`);
}

function renderText(body: string, ctx: TemplateVars): string {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const isHeading = line.startsWith("## ");
    const raw = substituteRaw(isHeading ? line.slice(3) : line, ctx);
    // A line that was only placeholders and came out empty disappears.
    if (raw.trim() === "" && line.trim() !== "") continue;
    out.push(raw.replace(/[ \t]+$/g, ""));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderHtml(body: string, ctx: TemplateVars): string {
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };

  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      const heading = substituteHtml(line.slice(3), ctx).trim();
      if (heading) blocks.push(`<h2>${heading}</h2>`);
      continue;
    }
    const only = ONLY_VAR_LINE.exec(line);
    if (only) {
      const value = valueOf(ctx, only[1]);
      if (value.trim() === "") continue;
      if (value.includes("\n")) {
        flush();
        const items = value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => `<div class="bp-item">${linkify(escapeHtml(l))}</div>`);
        blocks.push(`<div class="bp-list">${items.join("")}</div>`);
        continue;
      }
    }
    const html = substituteHtml(line, ctx);
    if (html.trim() === "") continue;
    para.push(html.trim());
  }
  flush();
  return blocks.join("\n");
}

/** Render a template's subject and body with the given values. */
export function renderTemplate(template: { subject: string; body: string }, ctx: TemplateVars): RenderedEmail {
  const subject = substituteRaw(resolveIfs(template.subject, ctx), ctx).replace(/\s+/g, " ").trim();
  const body = resolveIfs(template.body, ctx);
  return { subject, html: renderHtml(body, ctx), text: renderText(body, ctx) };
}

/** A call-to-action link that `wrapHtml` styles as a button. */
export function buttonHtml(href: string, label: string): string {
  return `<a class="bp-button" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function safeColour(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : fallback;
}

/**
 * Wrap rendered body HTML in a complete email document: inline styles only,
 * no tables, max 560px wide, system font, brand colour on headings and buttons,
 * and a footer with the legal lines passed in.
 */
export function wrapHtml(innerHtml: string, brand: Brand, opts: { title?: string; preheader?: string } = {}): string {
  const primary = safeColour(brand.primary, "#5bbf3a");
  const ink = safeColour(brand.ink, "#1b1f1a");
  const muted = "#6b7068";

  const styled = innerHtml
    .replace(/<h2>/g, `<h2 style="margin:24px 0 8px;font-size:18px;line-height:1.3;color:${primary};">`)
    .replace(/<p>/g, `<p style="margin:0 0 16px;">`)
    .replace(/<div class="bp-list">/g, `<div style="margin:0 0 16px;">`)
    .replace(/<div class="bp-item">/g, `<div style="padding:4px 0;border-bottom:1px solid #eef0ec;">`)
    .replace(
      /<a class="bp-button" href=/g,
      `<a style="display:inline-block;padding:12px 20px;border-radius:8px;background:${primary};color:#ffffff;font-weight:600;text-decoration:none;" href=`,
    )
    .replace(/<a href=/g, `<a style="color:${ink};text-decoration:underline;" href=`);

  const footer = brand.footerLines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<div>${escapeHtml(l)}</div>`)
    .join("");

  const title = escapeHtml(opts.title ?? brand.name);
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>`
    : "";

  return [
    `<!doctype html>`,
    `<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`,
    `<body style="margin:0;padding:0;background:#f5f6f3;">`,
    preheader,
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:${ink};">`,
    `<div style="margin:0 0 16px;font-size:20px;font-weight:700;color:${primary};">${escapeHtml(brand.name)}</div>`,
    `<div style="background:#ffffff;border-radius:12px;padding:20px;">`,
    styled,
    `</div>`,
    footer ? `<div style="margin-top:16px;font-size:12px;line-height:1.5;color:${muted};">${footer}</div>` : "",
    `</div>`,
    `</body></html>`,
  ]
    .filter(Boolean)
    .join("\n");
}
