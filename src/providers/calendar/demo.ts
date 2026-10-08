import type { CalendarEventInput, CalendarProvider } from "../types";

/** Demo calendar: the calendar_log table (written by the calendar service) is the record. */
export class DemoCalendarProvider implements CalendarProvider {
  readonly name = "demo" as const;

  async createEvent(input: CalendarEventInput): Promise<{ eventId: string }> {
    return { eventId: `demo_evt_${input.bookingId}` };
  }

  async updateEvent(): Promise<void> {}

  async deleteEvent(): Promise<void> {}
}
