/**
 * The id of the hold this tab placed, kept in sessionStorage so the thank-you page can release it
 * when the customer cancels on the payment page. Every call is best effort: storage can be blocked.
 */
const KEY = "baypook-hold-id";

export function rememberHold(id: string): void {
  try {
    window.sessionStorage.setItem(KEY, id);
  } catch {
    // Storage blocked: the hold simply lapses on its own.
  }
}

export function storedHoldId(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Forget the stored hold, but only if it is still `id` (when given). */
export function forgetHold(id?: string): void {
  try {
    if (id === undefined || window.sessionStorage.getItem(KEY) === id) window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}
