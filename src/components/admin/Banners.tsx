import Link from "next/link";

/** Slim strip shown on every admin page in demo mode. */
export function DemoStrip() {
  return (
    <div className="bg-ink px-4 py-1.5 text-center text-sm font-semibold text-white" role="note">
      Demo mode: nothing leaves this machine.{" "}
      <Link href="/admin/outbox" className="text-white underline underline-offset-2">
        Outbox
      </Link>
    </div>
  );
}

/** Amber warnings for a half-configured live system. */
export function FallbackBanners({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="mx-auto mt-3 flex max-w-3xl flex-col gap-2 px-4">
      {messages.map((m) => (
        <div key={m} role="status" className="rounded-xl border border-warn-line bg-warn-bg px-3 py-2 text-sm font-medium text-warn-ink">
          {m.replace(/ See Connections\.$/, "")}{" "}
          {m.endsWith("See Connections.") ? (
            <Link href="/admin/connections" className="font-semibold text-warn-ink underline">
              See Connections
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
