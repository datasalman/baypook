import type { Metadata } from "next";
import { env, envSuffixForSlug, mode } from "@/lib/env";
import { connectionStatuses } from "@/providers";
import type { ConnectionState, ConnectionStatus } from "@/providers/types";
import { listVenues } from "@/server/org";
import { getAdminContext } from "@/server/venue-scope";
import { Badge, Banner, EmptyState, PageHeader, type BadgeTone } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connections" };

const SETUP_URL = "https://github.com/datasalman/baypook/blob/main/SETUP.md";

const STATE: Record<ConnectionState, { label: string; tone: BadgeTone }> = {
  connected: { label: "Connected", tone: "green" },
  demo: { label: "Demo", tone: "blue" },
  fallback: { label: "Not sending", tone: "amber" },
  missing: { label: "Missing", tone: "red" },
};

/** The env var names behind each status row. Names only, never values. */
function envVarsFor(row: ConnectionStatus): { name: string; note?: string }[] {
  if (row.key === "database") return [{ name: "DATABASE_URL" }];
  if (row.key.startsWith("stripe:")) {
    const suffix = envSuffixForSlug(row.key.slice("stripe:".length));
    return [{ name: `STRIPE_SECRET_KEY__${suffix}` }, { name: `STRIPE_WEBHOOK_SECRET__${suffix}` }];
  }
  if (row.key === "email") return [{ name: "RESEND_API_KEY" }, { name: "EMAIL_FROM" }, { name: "OWNER_ALERT_EMAIL", note: "optional" }];
  if (row.key === "calendar") {
    return [
      { name: "GOOGLE_SERVICE_ACCOUNT_JSON", note: "or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64" },
      { name: "Calendar ID per venue", note: "in Settings, Venues" },
    ];
  }
  if (row.key === "cron") return [{ name: "CRON_SECRET" }];
  if (row.key === "appSecret") return [{ name: "APP_SECRET" }];
  return [];
}

export default async function ConnectionsPage() {
  const ctx = await getAdminContext();
  if (!ctx.user.isOwner) {
    return (
      <>
        <PageHeader title="Connections" />
        <EmptyState title="Only the owner can see this page" />
      </>
    );
  }
  // Every venue, not just the selected one: each has its own Stripe account.
  const venues = await listVenues(ctx.db);
  const rows = connectionStatuses(venues);
  const isDemoMode = mode() === "demo";

  return (
    <>
      <PageHeader title="Connections" subtitle="Payments, email and calendar: what is set up and what is not" />
      <Banner tone={isDemoMode ? "info" : "warn"} className="mb-4">
        {isDemoMode ? (
          <>BayPook is in <strong>demo mode</strong>: nothing leaves this computer. </>
        ) : (
          <>BayPook is <strong>live</strong>. </>
        )}
        Address: <span className="break-all font-mono">{env.baseUrl()}</span> (BAYPOOK_URL)
      </Banner>
      <p className="mb-4 text-muted">
        Settings are environment variables on the server (Vercel, Project settings, Environment Variables). This page only checks whether
        each one is there; it never shows what they contain. Step by step help is in{" "}
        <a href={SETUP_URL} target="_blank" rel="noreferrer">
          SETUP.md
        </a>
        .
      </p>

      <ul className="grid gap-3">
        {rows.map((row) => {
          const st = STATE[row.state];
          const vars = envVarsFor(row);
          return (
            <li key={row.key} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="text-lg font-bold">{row.label}</h2>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <p className="mt-1">{row.detail}</p>
              {vars.length ? (
                <p className="mt-2 text-sm text-muted">
                  Set:{" "}
                  {vars.map((v, i) => (
                    <span key={v.name}>
                      {i > 0 ? ", " : null}
                      <code className="rounded bg-canvas px-1 py-0.5 font-mono text-ink">{v.name}</code>
                      {v.note ? ` (${v.note})` : null}
                    </span>
                  ))}
                </p>
              ) : null}
              <p className="mt-2 text-sm">
                <a href={SETUP_URL} target="_blank" rel="noreferrer">
                  {row.setupStep}
                </a>
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
