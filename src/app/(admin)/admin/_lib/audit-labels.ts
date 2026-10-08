/**
 * Plain words for audit log action names ("booking.cancel" -> "Cancelled a booking").
 * Unknown actions fall back to a humanised name. Pure.
 */
const ACTION_LABEL: Record<string, string> = {
  // bookings
  "booking.create_manual": "Created a booking",
  "booking.create_pay_in_store": "Booked online, to pay in store",
  "booking.create_pending": "Started an online booking",
  "booking.confirm_paid": "Paid online and confirmed",
  "booking.paid_after_cancel": "Payment arrived after it was cancelled",
  "booking.import": "Imported a booking",
  "booking.cancel": "Cancelled a booking",
  "booking.refund": "Gave a refund",
  "booking.refund_failed": "A refund failed",
  "booking.refund_external": "Recorded a refund made with the card provider",
  "booking.paid_in_store": "Recorded a payment in store",
  "booking.change_counts": "Changed places or extras",
  "booking.move": "Moved a booking",
  "booking.note": "Changed booking notes",
  "booking.no_show": "Marked a no-show",
  "booking.no_show_undo": "Undid a no-show",
  "booking.resend_confirmation": "Sent the confirmation again",
  "payment.dispute": "A card payment was disputed",
  "customer.notes": "Changed a note about a parent",
  // catalogue
  "service.create": "Added a service",
  "service.update": "Changed a service",
  "service.archive": "Archived a service",
  "service.restore": "Restored a service",
  "service.reorder": "Reordered services",
  "option.create": "Added an option",
  "option.update": "Changed an option",
  "option.archive": "Archived an option",
  "option.restore": "Restored an option",
  "addon.create": "Added an add-on",
  "addon.update": "Changed an add-on",
  "addon.archive": "Archived an add-on",
  "addon.restore": "Restored an add-on",
  "timetable.add": "Added timetable times",
  "timetable.capacity": "Changed places in the timetable",
  "timetable.delete": "Removed a timetable time",
  "timetable.fill": "Filled the timetable from opening hours",
  "exception.add": "Added a one-off change",
  "exception.delete": "Removed a one-off change",
  "session.add": "Added a session",
  "session.cancel": "Cancelled a session",
  "session.capacity": "Changed places at a session",
  "session.restore": "Restored a session",
  "block.create": "Blocked out time",
  "block.delete": "Removed a block",
  // settings
  "organisation.update": "Changed the organisation details",
  "venue.create": "Added a venue",
  "venue.update": "Changed venue details",
  "room.create": "Added a room",
  "room.rename": "Renamed a room",
  "room.delete": "Removed a room",
  "terms.new_version": "Saved a new version of the terms",
  "terms.wording": "Changed the terms wording",
  "waiver.new_version": "Saved a new version of the waiver",
  "waiver.wording": "Changed the waiver wording",
  "email_template.update": "Changed an email",
  // people and operations
  "user.invite": "Invited someone",
  "user.update": "Changed someone's access",
  "user.send_link": "Sent a sign-in link",
  "user.deactivate": "Turned off a login",
  "user.reactivate": "Turned a login back on",
  "email.resend": "Sent an email again",
  "calendar.retry": "Tried a calendar update again",
  "job.run": "Ran a job by hand",
};

/** "catalogue.option.update" and "option.update" both read "Changed an option". */
export function auditActionLabel(action: string): string {
  const key = action.replace(/^catalogue\./, "");
  const known = ACTION_LABEL[key];
  if (known) return known;
  if (key.startsWith("booking.cancel_pending")) return "Cancelled an unpaid booking";
  return humaniseName(key);
}

/** "booking.change_counts" -> "Booking change counts" */
export function humaniseName(name: string): string {
  const t = name.replace(/[._]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
