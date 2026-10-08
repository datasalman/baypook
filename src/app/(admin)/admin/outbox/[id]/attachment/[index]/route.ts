/** Download one stored attachment of an Outbox email (for example the .ics). */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as s from "@/db/schema";
import { canAccessVenue, getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";

const SAFE_TYPE = /^[a-z]+\/[a-z0-9.+-]+(;\s*[a-z-]+=[a-z0-9-]+)*$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Please sign in.", { status: 401 });
  const { id, index } = await params;
  const i = Number(index);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(i) || i < 0) return new Response("Not found", { status: 404 });

  const db = await getDb();
  const [row] = await db.select().from(s.notifications).where(eq(s.notifications.id, id)).limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const allowed = row.venueId ? canAccessVenue(user, row.venueId) : user.isOwner;
  if (!allowed) return new Response("Not found", { status: 404 });

  const att = row.attachments[i];
  if (!att) return new Response("Not found", { status: 404 });
  const type = SAFE_TYPE.test(att.contentType) ? att.contentType : "application/octet-stream";
  const filename = att.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "attachment";
  return new Response(att.content, {
    headers: {
      "content-type": type.includes("charset") || !type.startsWith("text/") ? type : `${type}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
