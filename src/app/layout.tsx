import type { Metadata, Viewport } from "next";
import { cache } from "react";
import { connection } from "next/server";
import { brandColours, brandCss } from "@/components/ui/brand";
import "./globals.css";

type BrandOrg = { name: string; brandPrimary: string; brandInk: string } | null;

/** The organisation's name and colours; falls back to defaults if the database is not reachable. */
const loadBrandOrg = cache(async (): Promise<BrandOrg> => {
  await connection();
  try {
    const { getDb } = await import("@/db");
    const { getOrganisation } = await import("@/server/org");
    const org = await getOrganisation(await getDb());
    return { name: org.name, brandPrimary: org.brandPrimary, brandInk: org.brandInk };
  } catch (e) {
    console.error("[layout] could not load organisation branding", e);
    return null;
  }
});

export async function generateMetadata(): Promise<Metadata> {
  const org = await loadBrandOrg();
  const name = org?.name ?? "BayPook";
  return {
    title: { default: `${name} admin`, template: `%s · ${name}` },
    description: `Bookings and payments for ${name}`,
    applicationName: `${name} admin`,
    manifest: "/manifest.webmanifest",
    icons: {
      // `src/app/icon.svg` and `favicon.ico` are picked up by file convention.
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    appleWebApp: { capable: true, title: name, statusBarStyle: "default" },
    formatDetection: { telephone: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const org = await loadBrandOrg();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: brandColours(org).brand,
    colorScheme: "light",
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const org = await loadBrandOrg();
  return (
    <html lang="en-GB">
      <head>
        <style id="brand-tokens" dangerouslySetInnerHTML={{ __html: brandCss(org) }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
