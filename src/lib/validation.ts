/**
 * Zod schemas for the public API bodies and queries (docs/API.md).
 * Messages are customer-facing: short and plain.
 */
import { z } from "zod";
import { isValidDateStr } from "@/core/time";

const id = z.string().trim().min(1, { error: "Missing id." }).max(200);
const qty = z.number({ error: "Quantities must be numbers." }).int({ error: "Quantities must be whole numbers." }).min(0).max(1000);

export const lineSchema = z.object({ optionId: id, qty });
export const addOnSchema = z.object({ addOnId: id, qty });

export const quoteBodySchema = z.object({
  venue: z.string().trim().min(1, { error: "Choose a venue." }).max(100),
  service: id,
  lines: z.array(lineSchema).max(50).default([]),
  addOns: z.array(addOnSchema).max(50).default([]),
});
export type QuoteBody = z.infer<typeof quoteBodySchema>;

export const holdBodySchema = quoteBodySchema.extend({
  sessionId: z.string().trim().max(200).nullish(),
  startsAt: z.iso.datetime({ offset: true, error: "startsAt must be an ISO date and time." }).nullish(),
});
export type HoldBody = z.infer<typeof holdBodySchema>;

const name = (what: string) =>
  z
    .string({ error: `Please enter ${what}.` })
    .trim()
    .min(1, { error: `Please enter ${what}.` })
    .max(80, { error: `${what[0].toUpperCase()}${what.slice(1)} is too long.` });

export const checkoutBodySchema = z.object({
  holdId: z.string({ error: "Missing holdId." }).trim().min(1).max(200),
  customer: z.object({
    firstName: name("your first name"),
    lastName: name("your last name"),
    email: z.email({ error: "Please enter a valid e-mail address." }).max(200),
    phone: z
      .string({ error: "Please enter a phone number." })
      .trim()
      .min(6, { error: "Please enter a phone number." })
      .max(40, { error: "That phone number is too long." }),
  }),
  birthdayChild: z
    .object({
      firstName: name("the birthday child's first name"),
      age: z.number({ error: "Please enter the birthday child's age." }).int().min(1).max(18),
    })
    .nullish(),
  message: z.string().trim().max(1000, { error: "Your message is too long (1,000 characters at most)." }).nullish(),
  accept: z.object({
    terms: z.literal(true, { error: "Please accept the terms." }),
    waiver: z.literal(true, { error: "Please accept the waiver." }),
  }),
  returnUrl: z.url({ error: "returnUrl must be a full URL." }).max(1000).nullish(),
  payInStore: z.boolean().optional(),
});
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

const dateStr = z.string().refine(isValidDateStr, { error: "Dates must be YYYY-MM-DD." });

export const availabilityQuerySchema = z.object({
  service: z.string({ error: "Choose a service." }).trim().min(1, { error: "Choose a service." }).max(200),
  from: dateStr,
  to: dateStr.optional(),
  extraMinutes: z.coerce
    .number({ error: "extraMinutes must be a number." })
    .int()
    .min(0, { error: "extraMinutes must be between 0 and 180." })
    .max(180, { error: "extraMinutes must be between 0 and 180." })
    .default(0),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/** Query string -> plain object (only the first value of each key). */
export function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (!(key in out)) out[key] = value;
  });
  return out;
}
