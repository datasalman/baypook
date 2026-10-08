import { JWT } from "google-auth-library";
import type { CalendarEventInput, CalendarProvider } from "../types";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

/**
 * Google Calendar via a service account. The service account's email must be
 * given "Make changes to events" on each venue calendar (SETUP.md step 3).
 * One-way push: BayPook writes, never reads back.
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
    if (!res.ok) throw new Error(`Google Calendar ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
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

  async createEvent(input: CalendarEventInput): Promise<{ eventId: string }> {
    const ev = await this.request<{ id: string }>("POST", `/calendars/${encodeURIComponent(input.calendarId)}/events`, this.toBody(input));
    return { eventId: ev.id };
  }

  async updateEvent(eventId: string, input: CalendarEventInput): Promise<void> {
    await this.request("PATCH", `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(eventId)}`, this.toBody(input));
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e instanceof Error && /\b(404|410)\b/.test(e.message)) return;
      throw e;
    }
  }
}
