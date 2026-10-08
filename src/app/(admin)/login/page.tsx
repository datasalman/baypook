import type { Metadata } from "next";
import { getDb } from "@/db";
import { isDemo } from "@/lib/env";
import { getOrganisation } from "@/server/org";
import { DEMO_USERS, getCurrentUser, safeNextPath } from "@/server/auth";
import { Banner, Button } from "@/components/ui";
import { LoginForm } from "@/components/admin/LoginForm";
import { demoSignInAction, requestLinkAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  expired: "That sign-in link has expired or was already used. Ask for a new one below.",
  invalid: "That sign-in link did not work. Ask for a new one below.",
  forbidden: "Your account cannot sign in. Ask the owner to check it in Users and invites.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const nextRaw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = safeNextPath(nextRaw, "/admin");
  const errorKey = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  const db = await getDb();
  const [org, user] = await Promise.all([getOrganisation(db), getCurrentUser()]);
  const demo = isDemo();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <span aria-hidden className="inline-block h-10 w-10 rounded-xl bg-brand" />
        <div>
          <h1 className="text-2xl font-bold leading-tight">Sign in</h1>
          <p className="text-muted">{org.name} admin</p>
        </div>
      </div>

      {errorKey && ERRORS[errorKey] ? (
        <Banner tone="danger" className="mb-4">
          {ERRORS[errorKey]}
        </Banner>
      ) : null}

      {user ? (
        <div className="mb-6 rounded-2xl border border-line bg-surface p-4">
          <p>
            You are signed in as <strong>{user.name || user.email}</strong>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button href={next}>Go to the admin</Button>
            <form action="/auth/logout" method="post">
              <Button type="submit" variant="secondary">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      <LoginForm action={requestLinkAction} next={next} />

      {demo ? (
        <section aria-labelledby="demo-title" className="mt-8 rounded-2xl border-2 border-dashed border-brand/60 bg-surface p-4">
          <h2 id="demo-title" className="text-lg font-bold">
            Demo mode
          </h2>
          <p className="mb-3 text-sm text-muted">Nothing leaves this machine. Pick who to be; no email needed.</p>
          <div className="flex flex-col gap-2">
            {DEMO_USERS.map((u) => (
              <form key={u.email} action={demoSignInAction}>
                <input type="hidden" name="email" value={u.email} />
                <input type="hidden" name="next" value={next} />
                <Button type="submit" size="lg" block variant={u.email.startsWith("owner") ? "primary" : "secondary"}>
                  {u.label}
                </Button>
              </form>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
