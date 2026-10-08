import { describe, expect, it } from "vitest";
import { buttonHtml, escapeHtml, renderTemplate, wrapHtml } from "@/providers/email/render";
import { DEFAULT_TEMPLATES, PLACEHOLDERS } from "@/providers/email/defaults";

describe("renderTemplate", () => {
  it("substitutes placeholders in subject, text and HTML; missing keys are empty", () => {
    const r = renderTemplate({ subject: "Hi {{ firstName }} {{missing}}", body: "Hello {{firstName}}, ref {{reference}}{{missing}}." }, {
      firstName: "Amina",
      reference: "BP-7K3M2",
    });
    expect(r.subject).toBe("Hi Amina");
    expect(r.text).toBe("Hello Amina, ref BP-7K3M2.");
    expect(r.html).toBe("<p>Hello Amina, ref BP-7K3M2.</p>");
  });

  it("keeps {{#if}} content only when the value is non-empty, inline and across lines", () => {
    const tpl = {
      subject: "{{#if a}}A {{/if}}subject",
      body: "Start {{#if a}}[{{a}}]{{/if}} end\n{{#if b}}{{b}}{{/if}}\n{{#if a}}\nmulti {{a}}\nline\n{{/if}}\nLast",
    };
    const on = renderTemplate(tpl, { a: "yes", b: "bee" });
    expect(on.subject).toBe("A subject");
    expect(on.text).toBe("Start [yes] end\nbee\n\nmulti yes\nline\n\nLast");

    const off = renderTemplate(tpl, { a: "  ", b: null });
    expect(off.subject).toBe("subject");
    // The line holding only a falsy block disappears instead of leaving a blank line.
    expect(off.text).toBe("Start  end\nLast");
    expect(off.html).not.toContain("multi");
  });

  it("supports nested #if blocks", () => {
    const r = renderTemplate({ subject: "", body: "{{#if a}}A{{#if b}}B{{/if}}{{/if}}" }, { a: "1" });
    expect(r.text).toBe("A");
  });

  it("turns ## lines into headings and blank lines into paragraphs with <br> between lines", () => {
    const r = renderTemplate({ subject: "s", body: "Hello\n\n## {{title}}\nLine one\nLine two\n\nBye" }, { title: "Classic Workshops" });
    expect(r.html).toBe("<p>Hello</p>\n<h2>Classic Workshops</h2>\n<p>Line one<br>Line two</p>\n<p>Bye</p>");
    expect(r.text).toBe("Hello\n\nClassic Workshops\nLine one\nLine two\n\nBye");
  });

  it("renders a multi-line value on its own line as a list", () => {
    const r = renderTemplate({ subject: "", body: "## What you booked\n{{whatBooked}}\nPaid online: {{total}}" }, {
      whatBooked: "2 × Slime Workshop  £34.00\n1 × Decoden Craft Workshop  £10.00",
      total: "£44.00",
    });
    expect(r.html).toContain('<div class="bp-list"><div class="bp-item">2 × Slime Workshop  £34.00</div><div class="bp-item">1 × Decoden Craft Workshop  £10.00</div></div>');
    expect(r.html).toContain("<p>Paid online: £44.00</p>");
    expect(r.text).toContain("2 × Slime Workshop  £34.00\n1 × Decoden Craft Workshop  £10.00\nPaid online: £44.00");
  });

  it("escapes values in HTML but not in text, and drops lines that render empty", () => {
    const r = renderTemplate({ subject: "{{x}}", body: "Name: {{x}}\n{{empty}}\nAfter" }, { x: `<b>"Tom" & 'Jo'</b>`, empty: "" });
    expect(r.html).toContain("Name: &lt;b&gt;&quot;Tom&quot; &amp; &#39;Jo&#39;&lt;/b&gt;<br>After");
    expect(r.html).not.toContain("<b>");
    expect(r.text).toBe(`Name: <b>"Tom" & 'Jo'</b>\nAfter`);
    expect(r.subject).toBe(`<b>"Tom" & 'Jo'</b>`);
  });

  it("links bare URLs in HTML", () => {
    const r = renderTemplate({ subject: "", body: "Open it: {{adminUrl}}." }, { adminUrl: "https://admin.example.com/b/1?a=1&b=2" });
    expect(r.html).toBe('<p>Open it: <a href="https://admin.example.com/b/1?a=1&amp;b=2">https://admin.example.com/b/1?a=1&amp;b=2</a>.</p>');
  });

  it("renders every default template with every placeholder filled", () => {
    const ctx = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, `<${p.key}>`]));
    for (const t of DEFAULT_TEMPLATES) {
      const r = renderTemplate(t, ctx);
      expect(r.text).not.toMatch(/\{\{/);
      expect(r.html).not.toMatch(/\{\{/);
      expect(r.subject).not.toMatch(/\{\{/);
      expect(r.html).not.toContain("<firstName>");
      expect(r.text).toContain("<reference>");
    }
  });
});

describe("wrapHtml", () => {
  const brand = {
    name: "Slimedom",
    primary: "#5bbf3a",
    ink: "#1b1f1a",
    footerLines: ["Slimedom Ltd", "1 High Street, London", "Company number 01234567", ""],
  };

  it("produces a complete, table-free document with brand colours and footer lines", () => {
    const inner = renderTemplate({ subject: "", body: "## Heading\nText" }, {}).html + buttonHtml("https://x.test/a?b=1&c=2", "Sign in");
    const html = wrapHtml(inner, brand, { title: "Your booking", preheader: "All set" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("max-width:560px");
    expect(html).toContain("<title>Your booking</title>");
    expect(html).not.toMatch(/<table/i);
    expect(html).toMatch(/<h2 style="[^"]*color:#5bbf3a;[^"]*">Heading<\/h2>/);
    expect(html).toMatch(/<a style="[^"]*background:#5bbf3a;[^"]*" href="https:\/\/x\.test\/a\?b=1&amp;c=2">Sign in<\/a>/);
    expect(html).toContain("color:#1b1f1a");
    for (const line of brand.footerLines.filter(Boolean)) expect(html).toContain(`<div>${line}</div>`);
    expect(html).toContain("All set");
  });

  it("refuses unsafe colours and escapes the brand name", () => {
    const html = wrapHtml("<p>x</p>", { ...brand, name: "A & B", primary: "red;background:url(x)", footerLines: [] });
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("url(x)");
    expect(html).toContain("#5bbf3a");
  });
});

describe("escapeHtml", () => {
  it("escapes the five special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
