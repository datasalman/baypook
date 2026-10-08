/**
 * Audit log: who did what to which record, with before/after snapshots.
 * Every admin action that changes data should call `audit()`.
 */
import { and, desc, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import * as s from "@/db/schema";
import type { CurrentUser } from "./auth";

export type AuditInput = {
  user: CurrentUser | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  venueId?: string | null;
  before?: unknown;
  after?: unknown;
};

/** JSON-safe copy (Dates become ISO strings, undefined is dropped). */
function toJson(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return String(v);
  }
}

export async function audit(db: DbOrTx, input: AuditInput): Promise<s.AuditLogRow> {
  const [row] = await db
    .insert(s.auditLog)
    .values({
      userId: input.user?.id ?? null,
      actor: input.user?.email ?? "system",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      venueId: input.venueId ?? null,
      before: toJson(input.before),
      after: toJson(input.after),
    })
    .returning();
  return row;
}

export type ListAuditOptions = {
  /** Restrict to these venues. `null`/omitted = every row (owner). */
  venueIds?: string[] | null;
  /** With `venueIds`, also include rows that belong to no venue (organisation-wide). Default false. */
  includeOrgWide?: boolean;
  limit?: number;
  /** Case-insensitive match on actor, action, entity type or entity id. */
  search?: string;
};

export async function listAudit(db: DbOrTx, opts: ListAuditOptions = {}): Promise<s.AuditLogRow[]> {
  const where: SQL[] = [];
  if (opts.venueIds) {
    if (opts.venueIds.length === 0 && !opts.includeOrgWide) return [];
    const parts: SQL[] = [];
    if (opts.venueIds.length) parts.push(inArray(s.auditLog.venueId, opts.venueIds));
    if (opts.includeOrgWide) parts.push(isNull(s.auditLog.venueId));
    const venueCond = parts.length === 1 ? parts[0] : or(...parts);
    if (venueCond) where.push(venueCond);
  }
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const cond = or(
      ilike(s.auditLog.actor, like),
      ilike(s.auditLog.action, like),
      ilike(s.auditLog.entityType, like),
      ilike(s.auditLog.entityId, like),
    );
    if (cond) where.push(cond);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return db
    .select()
    .from(s.auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.auditLog.createdAt))
    .limit(limit);
}
