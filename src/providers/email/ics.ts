/**
 * Minimal RFC 5545 iCalendar builder for the "Add to calendar" attachment.
 * One VCALENDAR with one VEVENT; UTC times; CRLF line endings; lines folded at
 * 75 octets (never inside a UTF-8 character); TEXT values escaped.
 */

export type IcsMethod = "PUBLISH" | "CANCEL";

export type IcsInput = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  organiserName: string;
  organiserEmail: string;
  url?: string;
  sequence?: number;
  method?: IcsMethod;
  /** DTSTAMP; defaults to now. */
  stamp?: Date;
  /** Minutes before the start for the display reminder (default 24 hours). Not added to cancellations. */
  alarmMinutesBefore?: number;
};

const CRLF = "\r\n";

/** `20261018T090000Z` */
export function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Escape a TEXT value: backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** A parameter value (e.g. CN): DQUOTE is not allowed; quote when it holds `:;,`. */
function paramValue(value: string): string {
  const clean = value.replace(/["\r\n]/g, "").trim();
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

function utf8Size(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Fold a content line to at most 75 octets per physical line (continuations start with a space). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  const limit = 75;
  for (const ch of line) {
    const size = utf8Size(ch);
    if (bytes + size > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** Build the calendar file. */
export function buildIcs(input: IcsInput): string {
  const method: IcsMethod = input.method ?? "PUBLISH";
  const cancelled = method === "CANCEL";
  const alarmMinutes = input.alarmMinutesBefore ?? 24 * 60;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BayPook//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid.replace(/[\r\n]/g, "")}`,
    `DTSTAMP:${icsUtc(input.stamp ?? new Date())}`,
    `DTSTART:${icsUtc(input.start)}`,
    `DTEND:${icsUtc(input.end)}`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence ?? 0))}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
    `DESCRIPTION:${escapeIcsText(input.description)}`,
    `LOCATION:${escapeIcsText(input.location)}`,
  ];
  if (input.url) lines.push(`URL:${input.url.replace(/[\r\n]/g, "")}`);
  lines.push(`ORGANIZER;CN=${paramValue(input.organiserName)}:mailto:${input.organiserEmail.replace(/[\r\n\s]/g, "")}`);
  lines.push(`STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`);
  lines.push(`TRANSP:${cancelled ? "TRANSPARENT" : "OPAQUE"}`);
  if (!cancelled && alarmMinutes > 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(`Reminder: ${input.summary}`)}`,
      `TRIGGER:-PT${alarmMinutes % 60 === 0 ? `${alarmMinutes / 60}H` : `${Math.floor(alarmMinutes)}M`}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldLine).join(CRLF) + CRLF;
}
