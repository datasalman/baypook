import type { Metadata } from "next";
import Link from "next/link";
import { isDemo } from "@/lib/env";
import { getAdminContext } from "@/server/venue-scope";
import { roleAt } from "@/server/auth";
import { ADMIN_SECTION_GROUPS } from "@/components/admin/sections";
import { PageHeader, SectionTitle } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "More" };

const ROLE_LABEL = { owner: "Owner", manager: "Manager", staff: "Staff" } as const;

export default async function MorePage() {
  const ctx = await getAdminContext();
  const roles = ctx.user.isOwner
    ? "Owner, all venues"
    : ctx.venues
        .map((v) => {
          const r = roleAt(ctx.user, v.id);
          return r ? `${ROLE_LABEL[r]}, ${v.name}` : null;
        })
        .filter(Boolean)
        .join("; ");

  return (
    <>
      <PageHeader title="More" subtitle={`Signed in as ${ctx.user.name || ctx.user.email}`} />
      <p className="-mt-2 mb-4 text-sm text-muted">
        {ctx.user.email} · {roles || "No venue yet"}
      </p>

      {ADMIN_SECTION_GROUPS.map((group) => {
        const items = group.items.filter((i) => !i.ownerOnly || ctx.user.isOwner);
        if (!items.length) return null;
        return (
          <section key={group.title}>
            <SectionTitle>{group.title}</SectionTitle>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="flex min-h-14 items-center gap-3 px-4 py-3 text-ink no-underline hover:bg-canvas">
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-semibold">{item.label}</span>
                      <span className="block text-sm text-muted">{item.description}</span>
                    </span>
                    <span aria-hidden className="text-xl text-muted">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="mt-8">
        <form action="/auth/logout" method="post">
          <button
            type="submit"
            className="min-h-12 w-full rounded-xl border-2 border-line bg-surface px-4 text-base font-semibold text-ink hover:border-ink/40"
          >
            Sign out
          </button>
        </form>
        {isDemo() ? (
          <p className="mt-3 text-center text-sm text-muted">
            Demo mode. <Link href="/login">Sign in as someone else</Link>
          </p>
        ) : null}
      </section>
    </>
  );
}
