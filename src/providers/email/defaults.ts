/**
 * Default email templates, seeded into `email_templates` and editable in Settings.
 * Placeholders: {{name}} is replaced; lines wrapped in {{#if key}} … {{/if}} are
 * kept only when the key has a value. British, warm, short. No exclamation marks
 * in headings, no emojis.
 */

export type TemplateKey = "confirmation" | "reminder" | "cancellation" | "refund" | "owner_new_party";

export type DefaultTemplate = { key: TemplateKey; name: string; subject: string; body: string };

export const PLACEHOLDERS: { key: string; meaning: string }[] = [
  { key: "firstName", meaning: "Parent's first name" },
  { key: "reference", meaning: "Booking reference, e.g. BP-7K3M2" },
  { key: "serviceName", meaning: "What was booked, e.g. Workshop" },
  { key: "venueName", meaning: "Venue name" },
  { key: "dayLong", meaning: "Full date, e.g. Saturday 18 October 2026" },
  { key: "startTime", meaning: "Start time, e.g. 14:00" },
  { key: "endTime", meaning: "End time, e.g. 15:00" },
  { key: "address", meaning: "Venue address" },
  { key: "parkingLine", meaning: "Parking and transport notes" },
  { key: "whatBooked", meaning: "Line items: options, add-ons and prices" },
  { key: "total", meaning: "Total paid, e.g. £34.00" },
  { key: "inStoreNote", meaning: "In-store note, when relevant" },
  { key: "birthdayChild", meaning: "Birthday child's first name (parties)" },
  { key: "contactLine", meaning: "How to reach the business (email, phone, WhatsApp)" },
  { key: "organisationName", meaning: "Business name" },
  { key: "refundAmount", meaning: "Amount refunded, e.g. £17.00" },
  { key: "refundToCard", meaning: "Set when the refund goes back to the card paid with online (use with #if)" },
  { key: "refundInStore", meaning: "Set when the refund was given back in store, cash or card machine (use with #if)" },
  { key: "paymentLine", meaning: "Paid online, Paid in store, To pay in store or Imported" },
  { key: "customerName", meaning: "Parent's full name (owner alerts)" },
  { key: "customerPhone", meaning: "Parent's phone (owner alerts)" },
  { key: "customerEmail", meaning: "Parent's email (owner alerts)" },
  { key: "adminUrl", meaning: "Link to the booking in the admin (owner alerts)" },
];

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    key: "confirmation",
    name: "Booking confirmation",
    subject: "Your {{serviceName}} booking at {{venueName}}, {{dayLong}}",
    body: `Hello {{firstName}},

You're booked. Here is everything you need.

## {{serviceName}}
{{dayLong}}, {{startTime}} to {{endTime}}
{{venueName}}, {{address}}
Reference {{reference}}

## What you booked
{{whatBooked}}
{{paymentLine}}: {{total}}
{{#if inStoreNote}}{{inStoreNote}}{{/if}}

## Before you come
{{#if parkingLine}}{{parkingLine}}{{/if}}
What to wear: something you don't mind getting glittery.
Please arrive five minutes early so everyone can start together.

## Need to change it?
Message or call us and we'll sort it out: {{contactLine}}

See you soon,
{{organisationName}}`,
  },
  {
    key: "reminder",
    name: "Reminder (day before)",
    subject: "Tomorrow: {{serviceName}} at {{venueName}}, {{startTime}}",
    body: `Hello {{firstName}},

A quick reminder that you're booked tomorrow.

## {{serviceName}}
{{dayLong}}, {{startTime}} to {{endTime}}
{{venueName}}, {{address}}
Reference {{reference}}
{{paymentLine}}: {{total}}

{{#if parkingLine}}{{parkingLine}}{{/if}}
What to wear: something you don't mind getting glittery.
{{#if inStoreNote}}{{inStoreNote}}{{/if}}

Need to change it? Message or call us: {{contactLine}}

See you tomorrow,
{{organisationName}}`,
  },
  {
    key: "cancellation",
    name: "Cancellation",
    subject: "Your booking {{reference}} has been cancelled",
    body: `Hello {{firstName}},

Your {{serviceName}} booking at {{venueName}} on {{dayLong}} at {{startTime}} has been cancelled.

Reference {{reference}}

If this is a surprise, or you'd like to rebook, message or call us: {{contactLine}}

{{organisationName}}`,
  },
  {
    key: "refund",
    name: "Refund confirmation",
    subject: "Refund of {{refundAmount}} for booking {{reference}}",
    body: `Hello {{firstName}},

{{#if refundToCard}}We've refunded {{refundAmount}} to the card you paid with. It usually shows within five to ten working days, depending on your bank.{{/if}}{{#if refundInStore}}We've given you {{refundAmount}} back in store.{{/if}}

Booking {{reference}}, {{serviceName}} at {{venueName}}, {{dayLong}}.

Any questions, message or call us: {{contactLine}}

{{organisationName}}`,
  },
  {
    key: "owner_new_party",
    name: "Owner alert: new party booking",
    subject: "New party: {{serviceName}} at {{venueName}}, {{dayLong}} {{startTime}}",
    body: `A new party has been booked.

## {{serviceName}}
{{dayLong}}, {{startTime}} to {{endTime}}
{{venueName}}
Reference {{reference}}
{{#if birthdayChild}}Birthday child: {{birthdayChild}}{{/if}}

## Booked by
{{customerName}}
{{customerPhone}}
{{customerEmail}}

## What they booked
{{whatBooked}}
{{paymentLine}}: {{total}}

Open it in the admin: {{adminUrl}}`,
  },
];
