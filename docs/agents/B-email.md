# Agent B: email rendering, `.ics` builder, notification service and calendar mirror service

Read `docs/agents/COMMON.md` first and follow it.

## Files you own
- `src/providers/email/render.ts`, `src/providers/email/ics.ts`, `src/providers/email/defaults.ts` (exists; you may refine copy and placeholders but keep the exported names `DEFAULT_TEMPLATES`, `PLACEHOLDERS`, `TemplateKey`, `DefaultTemplate`)
- `src/server/notifications.ts`, `src/server/calendar.ts`
- Tests: `tests/unit/email/*.test.ts`, `tests/unit/server/notifications.test.ts`, `tests/unit/server/calendar.test.ts`
- Save a copy of this brief as `docs/agents/B-email.md`.

Do not touch `src/providers/types.ts`, `src/providers/index.ts` or the adapters (`demo.ts`, `resend.ts`, `google.ts`); use them as they are: `getEmailProvider(): Promise<{ provider, fallback, reason? }>` and `getCalendarProvider(): Promise<{ provider, fallback, reason? }>` from `src/providers/index.ts`.

## 1. `src/providers/email/render.ts`
A tiny, dependency-free template engine for the bodies in `defaults.ts`:
- `{{key}}` substitution (HTML-escaped in the HTML output, raw in text). Missing keys render as empty strings.
- `{{#if key}}…{{/if}}` keeps the content only when the value is non-empty (works inline and across lines).
- Lines starting with `## ` become headings; blank lines separate paragraphs; other consecutive lines become `<br>`-separated lines in one paragraph. Lines in `{{whatBooked}}` should arrive pre-formatted as plain text with newlines; render them as a simple list (one `<div>` per line is fine).
- Export `renderTemplate(template: { subject: string; body: string }, ctx: Record<string, string | null | undefined>): { subject: string; html: string; text: string }` and `wrapHtml(innerHtml, brand: { name: string; primary: string; ink: string; footerLines: string[] })` producing a complete, phone-friendly, table-free HTML email with inline styles (max-width 560px, system font, brand colour on headings/buttons, footer with legal name/address/company number lines passed in). Keep the HTML small and plain.
- Export `buildTemplateContext(...)` is NOT here; it lives in `src/server/notifications.ts` (needs DB rows).

## 2. `src/providers/email/ics.ts`
`buildIcs(input: { uid: string; summary: string; description: string; location: string; start: Date; end: Date; organiserName: string; organiserEmail: string; url?: string; sequence?: number; method?: "PUBLISH" | "CANCEL" }): string` producing a valid RFC 5545 VCALENDAR with one VEVENT, UTC times (`DTSTART:20261018T090000Z`), `DTSTAMP`, CRLF line endings, 75-octet line folding, text escaping (`,` `;` `\n` `\\`). `PRODID:-//BayPook//EN`. Status CANCELLED when method is CANCEL. Add a 24-hour VALARM display reminder.

## 3. `src/server/notifications.ts`
```ts
export type TemplateKey = "confirmation" | "reminder" | "cancellation" | "refund" | "owner_new_party";
export type BookingEmailContext = { booking: s.Booking; customer: s.Customer; service: s.Service; venue: s.Venue; organisation: s.Organisation; options?: s.ServiceOption[] };
export async function loadBookingEmailContext(db: DbOrTx, bookingId: string): Promise<BookingEmailContext>;
export function buildTemplateContext(ctx: BookingEmailContext, extra?: { refundAmountPence?: number; adminUrl?: string }): Record<string, string>;  // every key in PLACEHOLDERS; whatBooked = one line per booking line and add-on, e.g. "2 × Slime Workshop  £34.00"; paymentLine = "Paid online" | "Paid in store" | "To pay in store" | "Imported"; parkingLine from venue.parkingNotes + transportNotes; inStoreNote from the booking's lines (option notes) and the service note; contactLine from org contact email/phone/WhatsApp; address = venue.address; times via fmtDayLong/fmtTime in org.timezone
export async function getTemplate(db: DbOrTx, organisationId: string, key: TemplateKey): Promise<{ subject: string; body: string }>;  // from email_templates, falling back to DEFAULT_TEMPLATES
export async function renderBookingEmail(db: DbOrTx, input: { bookingId: string; template: TemplateKey; extra?: {...} }): Promise<{ to: string; subject: string; html: string; text: string; attachments: EmailAttachment[]; venueId: string; bookingId: string }>;  // confirmation and reminder attach `booking-<reference>.ics` (method PUBLISH); cancellation attaches an ics with method CANCEL and sequence 1; owner alert goes to env.ownerAlertEmail() ?? organisation.contactEmail with adminUrl `${env.baseUrl()}/admin/bookings/${booking.id}`
export async function sendBookingEmail(db: DbOrTx, input: { bookingId: string; template: TemplateKey; to?: string; extra?: {...}; dedupe?: boolean }): Promise<s.Notification>;  // renders, inserts a `notifications` row (status queued), calls the provider, updates status sent|demo|failed with providerId/error/sentAt. Never throws on provider failure: records `failed` and returns the row. `dedupe: true` returns the existing row if a sent/demo notification with the same bookingId+template already exists (used by reminders for idempotency).
export async function sendRawEmail(db: DbOrTx, input: { to: string; subject: string; html: string; text: string; template: string; venueId?: string | null }): Promise<s.Notification>;  // for magic links and tests
export async function listOutbox(db: DbOrTx, opts: { venueIds?: string[] | null; limit?: number; search?: string }): Promise<s.Notification[]>;
export async function previewTemplate(db: DbOrTx, organisationId: string, key: TemplateKey, override?: { subject: string; body: string }): Promise<{ subject: string; html: string; text: string }>;  // renders with a realistic sample context (no DB booking needed) for the Settings preview
```
Attachments are stored on the notification row (`attachments` jsonb, content as UTF-8 text) so the Outbox can offer the `.ics` for download. The admin's magic-link email will call `sendRawEmail` with `template: "magic_link"`.

## 4. `src/server/calendar.ts`
```ts
export async function syncBookingToCalendar(db: DbOrTx, bookingId: string, action: "create" | "update" | "delete"): Promise<s.CalendarLogRow | null>;
```
Loads booking + venue + customer + service. If the venue has no `googleCalendarId`: in demo use `"demo"` as the calendar id; in live write a `failed` log row with error "No calendar ID for venue" and return it (never throw). Summary: `"<Service> – <Customer first name> (<places>)"` for sessions, `"<Service>: <birthday child or customer surname> (<places> children)"` for slots; description: reference, customer name/phone/email, lines, add-ons, notes, admin link; location: venue address. `create`: if the booking already has `googleEventId`, do an update instead; store `googleEventId` on the booking. `update`: if no event id, create. `delete`: no-op when no event id; clear the id after. Always write a `calendar_log` row (provider name, action, status ok|failed|demo, providerEventId, payload, error). Never throw; errors land in the row. Also export `listCalendarLog(db, { venueIds?, limit? })`.

## 5. Tests
- render: placeholders, `#if`, headings/paragraphs, escaping, wrapHtml contains brand colour and footer lines.
- ics: folding, escaping, CANCEL method, UTC format; parse your own output line by line.
- notifications (DB): with `createTestDb({ seed: true })`, insert a customer + a confirmed booking row directly (Slime Workshop ×2 at South Woodford on 2026-10-24 14:00 London; and a Slime Party on 2026-10-25 11:00 with Food time) then `sendBookingEmail` for confirmation → notification row status `demo` (tests run without BAYPOOK_MODE, which is live; set `process.env.BAYPOOK_MODE = "demo"` at the top of the test file before importing), attachment filename `booking-<ref>.ics`, body contains the venue address, "glittery", the in-store note only for Decoden, times rendered in London time (`14:00`). `dedupe` returns the same row. previewTemplate renders all five keys.
- calendar (DB): create logs a demo row and sets googleEventId; update reuses it; delete clears it.

Finish with `npm run check` green for your parts.
