import { JWT } from "google-auth-library";
import type { CalendarEventInput, CalendarProvider } from "../types";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

/** A failed Calendar API call. The message keeps the HTTP status (`... 404 ...`) for callers that match on it. */
export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

/**
 * The Google event id for a booking: the booking UUID without dashes. Google
 * event ids must use base32hex characters (a-v, 0-9) and be 5 to 1024 long; a
 * lower-case UUID's hex digits qualify. A stable id makes a repeated create
 * for one booking land on the same event instead of a duplicate (DECISIONS 35).
 */
export function googleEventIdFor(bookingId: string): string {
  return bookingId.replace(/-/g, "").toLowerCase();
}

type GoogleEvent = { id: string; status?: string };

/**
 * Google Calendar via a service account. The service account's email must be
 * given "Make changes and see event details" on each venue calendar (SETUP.md
 * step 3). One-way push: BayPook writes, never reads back.
 *
 * Events removed by hand: Google keeps a deleted event for a while with
 * `status: "cancelled"` (and its id stays taken), so an update that finds it
 * cancelled sets it back to `confirmed`, and a create that hits the taken id
 * (409) patches the existing event instead. Bringing a hand-deleted event back
 * is best-effort: once Google has purged it the update fails with 404 or 410
 * and the calendar service tries a fresh create.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google" as const;
  private auth: JWT;

  constructor(serviceAccountJson: string) {
    const creds = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string };
    this.auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: [SCOPE] });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { token } = await this.auth.getAccessToken();
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new GoogleCalendarError(`Google Calendar ${method} ${path}: ${res.status} ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private toBody(input: CalendarEventInput) {
    return {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      extendedProperties: { private: { baypookBookingId: input.bookingId } },
    };
  }

  private eventPath(calendarId: string, eventId: string): string {
    return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  }

  async createEvent(input: CalendarEventInput): Promise<{ eventId: string }> {
    const id = googleEventIdFor(input.bookingId);
    try {
      const ev = await this.request<GoogleEvent>("POST", `/calendars/${encodeURIComponent(input.calendarId)}/events`, {
        id,
        ...this.toBody(input),
      });
      return { eventId: ev.id };
    } catch (e) {
      // 409: an event with this id already exists (an earlier create whose reply
      // was lost, or one deleted by hand). Bring it up to date instead.
      if (!(e instanceof GoogleCalendarError && e.status === 409)) throw e;
      await this.updateEvent(id, input);
      return { eventId: id };
    }
  }

  async updateEvent(eventId: string, input: CalendarEventInput): Promise<void> {
    const path = this.eventPath(input.calendarId, eventId);
    const body = this.toBody(input);
    const ev = await this.request<GoogleEvent | undefined>("PATCH", path, body);
    // Deleted by hand in the calendar: restore it (best-effort, see above).
    if (ev?.status === "cancelled") await this.request("PATCH", path, { ...body, status: "confirmed" });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request("DELETE", this.eventPath(calendarId, eventId));
    } catch (e) {
      if (e instanceof GoogleCalendarError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }
}
