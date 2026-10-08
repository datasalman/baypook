import { describe, expect, it } from "vitest";
import { buildIcs, escapeIcsText, foldLine, icsUtc } from "@/providers/email/ics";

/** Unfold (RFC 5545 §3.1) and split into name/params/value. */
function parse(ics: string): { name: string; params: string; value: string }[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  return unfolded
    .split("\r\n")
    .filter((l) => l !== "")
    .map((l) => {
      const colon = l.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const head = l.slice(0, colon);
      const [name, ...params] = head.split(";");
      return { name, params: params.join(";"), value: l.slice(colon + 1) };
    });
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const base = {
  uid: "abc-123@baypook",
  summary: "Classic Workshops at Slimedom South Woodford",
  description: "Reference BP-7K3M2\n2 × Slime Workshop  £34.00; bring an apron, please\\thanks",
  location: "South Woodford, 53A George Lane, South Woodford, London E18 1LN",
  start: new Date("2026-10-24T13:00:00Z"),
  end: new Date("2026-10-24T14:00:00Z"),
  organiserName: "Slimedom",
  organiserEmail: "hello@slimedom.com",
  stamp: new Date("2026-10-08T09:30:15.123Z"),
};

describe("icsUtc / escapeIcsText", () => {
  it("formats UTC basic format", () => {
    expect(icsUtc(new Date("2026-10-18T09:00:00.000Z"))).toBe("20261018T090000Z");
  });
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });
});

describe("foldLine", () => {
  it("folds at 75 octets with a leading space on continuations", () => {
    const line = "DESCRIPTION:" + "x".repeat(200);
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(2);
    for (const l of folded) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    for (const l of folded.slice(1)) expect(l.startsWith(" ")).toBe(true);
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(line);
  });
  it("never splits a multi-byte character", () => {
    const line = "SUMMARY:" + "£×é😀".repeat(30);
    const folded = foldLine(line).split("\r\n");
    for (const l of folded) {
      expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
      expect(l).not.toContain("�");
    }
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(line);
  });
  it("leaves short lines alone", () => {
    expect(foldLine("VERSION:2.0")).toBe("VERSION:2.0");
  });
});

describe("buildIcs", () => {
  it("produces a valid PUBLISH calendar with one event, UTC times, CRLF and a 24h alarm", () => {
    const ics = buildIcs({ ...base, url: "https://maps.example.com/?q=a,b" });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // only CRLF line breaks
    for (const physical of ics.split("\r\n")) expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);

    const props = parse(ics);
    const names = props.map((p) => p.name);
    expect(names[0]).toBe("BEGIN");
    expect(props[0].value).toBe("VCALENDAR");
    expect(props.at(-1)).toEqual({ name: "END", params: "", value: "VCALENDAR" });
    expect(props.filter((p) => p.name === "BEGIN" && p.value === "VEVENT")).toHaveLength(1);

    const get = (n: string) => props.find((p) => p.name === n);
    expect(get("VERSION")?.value).toBe("2.0");
    expect(get("PRODID")?.value).toBe("-//BayPook//EN");
    expect(get("METHOD")?.value).toBe("PUBLISH");
    expect(get("UID")?.value).toBe("abc-123@baypook");
    expect(get("DTSTAMP")?.value).toBe("20261008T093015Z");
    expect(get("DTSTART")?.value).toBe("20261024T130000Z");
    expect(get("DTEND")?.value).toBe("20261024T140000Z");
    expect(get("SEQUENCE")?.value).toBe("0");
    expect(get("STATUS")?.value).toBe("CONFIRMED");
    expect(get("URL")?.value).toBe("https://maps.example.com/?q=a,b");
    expect(get("ORGANIZER")?.params).toBe("CN=Slimedom");
    expect(get("ORGANIZER")?.value).toBe("mailto:hello@slimedom.com");
    expect(unescapeText(get("SUMMARY")!.value)).toBe(base.summary);
    expect(unescapeText(get("DESCRIPTION")!.value)).toBe(base.description);
    expect(unescapeText(get("LOCATION")!.value)).toBe(base.location);
    expect(get("LOCATION")!.value).toContain("\\,");

    const alarmAt = names.indexOf("BEGIN", names.indexOf("SEQUENCE"));
    expect(props[alarmAt].value).toBe("VALARM");
    expect(props.find((p) => p.name === "TRIGGER")?.value).toBe("-PT24H");
    expect(props.find((p) => p.name === "ACTION")?.value).toBe("DISPLAY");
  });

  it("marks a CANCEL as cancelled with its sequence, and adds no alarm", () => {
    const ics = buildIcs({ ...base, method: "CANCEL", sequence: 1 });
    const props = parse(ics);
    const get = (n: string) => props.find((p) => p.name === n);
    expect(get("METHOD")?.value).toBe("CANCEL");
    expect(get("STATUS")?.value).toBe("CANCELLED");
    expect(get("SEQUENCE")?.value).toBe("1");
    expect(props.some((p) => p.value === "VALARM")).toBe(false);
  });

  it("quotes an organiser name holding separators", () => {
    const ics = buildIcs({ ...base, organiserName: 'Slimedom: "Kingdom", Ltd' });
    const org = parse(ics).find((p) => p.name === "ORGANIZER")!;
    expect(org.params).toBe('CN="Slimedom: Kingdom, Ltd"');
    expect(org.value).toBe("mailto:hello@slimedom.com");
  });
});
