import { Suspense } from "react";
import { isDemo } from "@/lib/env";
import { getAdminContext } from "@/server/venue-scope";
import { BottomNav, FlashToast, TopBar } from "@/components/ui";
import { DemoStrip, FallbackBanners } from "@/components/admin/Banners";
import { VenueSwitcher } from "@/components/admin/VenueSwitcher";
import { selectVenue } from "./_lib/actions";

export const dynamic = "force-dynamic";

/**
 * Admin chrome: demo strip, top bar with the venue switcher, fallback banners,
 * the page, the flash toast and the bottom nav.
 * Pages must still call `getAdminContext()` (or `requireUser()`) themselves:
 * layouts and pages render independently.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAdminContext();
  return (
    <div className="min-h-dvh">
      {isDemo() ? <DemoStrip /> : null}
      <TopBar
        title={ctx.org.name}
        right={
          ctx.canSwitchVenue ? (
            <VenueSwitcher
              venues={ctx.venues.map((v) => ({ id: v.id, name: v.name }))}
              selected={ctx.selectedVenueId}
              allowAll={ctx.user.isOwner}
              action={selectVenue}
            />
          ) : ctx.venues[0] ? (
            <span className="text-base font-semibold text-muted">{ctx.venues[0].name}</span>
          ) : null
        }
      />
      <FallbackBanners messages={ctx.fallbackBanners} />
      <main id="main" className="mx-auto max-w-3xl px-4 pb-28 pt-4">
        {children}
      </main>
      <Suspense fallback={null}>
        <FlashToast />
      </Suspense>
      <BottomNav />
    </div>
  );
}
