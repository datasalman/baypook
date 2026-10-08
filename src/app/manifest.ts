import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { brandColours } from "@/components/ui/brand";

/** PWA manifest: the admin installs to the home screen and opens on Today. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  await connection();
  let name = "BayPook";
  let org: { brandPrimary: string; brandInk: string } | null = null;
  try {
    const { getDb } = await import("@/db");
    const { getOrganisation } = await import("@/server/org");
    const row = await getOrganisation(await getDb());
    name = row.name;
    org = row;
  } catch {
    // Fall back to defaults when the database is not reachable.
  }
  const { brand } = brandColours(org);
  return {
    name: `${name} admin`,
    short_name: name,
    description: `Bookings and payments for ${name}`,
    start_url: "/admin",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f6f3",
    theme_color: brand,
    lang: "en-GB",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
