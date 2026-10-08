/**
 * Brand colour tokens from the organisation row, as CSS custom properties.
 * Pure (no React), so the root layout, manifest and tests can share it.
 */
export const FALLBACK_BRAND = "#5bbf3a";
export const FALLBACK_INK = "#1b1f1a";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A safe `#rrggbb` colour, or the fallback when the value is not a plain hex colour. */
export function safeHex(value: string | null | undefined, fallback: string): string {
  if (!value || !HEX.test(value.trim())) return fallback;
  const v = value.trim().toLowerCase();
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

function channel(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const h = safeHex(hex, "#000000");
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or ink, whichever reads better on the brand colour. */
export function contrastOn(brand: string, ink: string): string {
  return contrastRatio(brand, "#ffffff") >= contrastRatio(brand, ink) ? "#ffffff" : ink;
}

export type BrandInput = { brandPrimary?: string | null; brandInk?: string | null } | null | undefined;

export function brandColours(org: BrandInput): { brand: string; ink: string; contrast: string } {
  const brand = safeHex(org?.brandPrimary, FALLBACK_BRAND);
  const ink = safeHex(org?.brandInk, FALLBACK_INK);
  return { brand, ink, contrast: contrastOn(brand, ink) };
}

/** `:root { … }` rule for the root layout. Values are validated hex, so safe to inline. */
export function brandCss(org: BrandInput): string {
  const { brand, ink, contrast } = brandColours(org);
  return `:root{--brand:${brand};--ink:${ink};--brand-contrast:${contrast};}`;
}
