/** Every admin section, for the More page. Some are owner-only. */
export type AdminSection = {
  href: string;
  label: string;
  description: string;
  ownerOnly?: boolean;
};

export const ADMIN_SECTION_GROUPS: { title: string; items: AdminSection[] }[] = [
  {
    title: "Day to day",
    items: [
      { href: "/admin", label: "Today", description: "Sessions, parties and blocked time for one day" },
      { href: "/admin/week", label: "Week", description: "Seven days at a glance" },
      { href: "/admin/bookings", label: "Bookings", description: "Find a booking, or add one for a phone or walk-in customer" },
      { href: "/admin/customers", label: "Customers", description: "Search by name, phone or email; booking history" },
    ],
  },
  {
    title: "Money",
    items: [{ href: "/admin/reports", label: "Reports", description: "Takings by day and venue, refunds, no-shows, CSV export" }],
  },
  {
    title: "Set-up",
    items: [
      { href: "/admin/catalogue", label: "Catalogue", description: "Services, prices, options, add-ons, timetable and blocked time" },
      { href: "/admin/settings", label: "Settings", description: "Organisation, venues, policies, terms, email wording", ownerOnly: true },
      { href: "/admin/users", label: "Users and invites", description: "Who can sign in and what they can do", ownerOnly: true },
      { href: "/admin/connections", label: "Connections", description: "Stripe, email, calendar: connected or not", ownerOnly: true },
    ],
  },
  {
    title: "Logs",
    items: [
      { href: "/admin/outbox", label: "Outbox", description: "Every email sent, or that would have been sent" },
      { href: "/admin/calendar-log", label: "Calendar log", description: "Events pushed to Google Calendar" },
      { href: "/admin/jobs", label: "Jobs", description: "Reminders, hold clean-up and retention: last run, run now" },
      { href: "/admin/audit", label: "Audit log", description: "Who did what, and when" },
    ],
  },
];
