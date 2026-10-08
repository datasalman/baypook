/**
 * Flash messages travel in the URL: redirect to `withFlash("/admin/bookings/x", "Booking cancelled")`
 * and the admin layout's <FlashToast /> shows it once.
 */
export const FLASH_PARAM = "flash";
export const FLASH_KIND_PARAM = "flashKind";

export type FlashKind = "success" | "error";

export function withFlash(path: string, message: string, kind: FlashKind = "success"): string {
  const [base, hash = ""] = path.split("#");
  const [pathname, query = ""] = base.split("?");
  const q = new URLSearchParams(query);
  q.set(FLASH_PARAM, message.slice(0, 200));
  if (kind === "error") q.set(FLASH_KIND_PARAM, "error");
  else q.delete(FLASH_KIND_PARAM);
  return `${pathname}?${q.toString()}${hash ? `#${hash}` : ""}`;
}
