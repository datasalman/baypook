/**
 * Database boot. One Drizzle schema; two drivers:
 *  - demo: PGlite (embedded Postgres) under `.data/demo`, migrated and seeded on first use
 *  - live: Postgres via DATABASE_URL (migrations are applied by `npm run db:migrate`, not at runtime)
 */
import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema";
import { env, isDemo } from "@/lib/env";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type DbOrTx = Db | Tx;

export { schema };

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "src/db/migrations");

type Globals = { __baypookDb?: Promise<Db>; __baypookPglite?: unknown };
const g = globalThis as unknown as Globals;

/** The application database. Cached across hot reloads. */
export function getDb(): Promise<Db> {
  if (!g.__baypookDb) {
    g.__baypookDb = init().catch((e) => {
      g.__baypookDb = undefined;
      throw e;
    });
  }
  return g.__baypookDb;
}

async function init(): Promise<Db> {
  if (isDemo()) return initDemo();
  return initLive();
}

async function initLive(): Promise<Db> {
  const url = env.databaseUrl();
  if (!url) throw new Error("DATABASE_URL is required in live mode (set BAYPOOK_MODE=demo to run without one)");
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: 5 });
  return drizzle(pool, { schema }) as unknown as Db;
}

async function initDemo(): Promise<Db> {
  const dir = path.resolve(process.cwd(), env.demoDir());
  fs.mkdirSync(dir, { recursive: true });
  const db = await openPglite(dir);
  await migratePglite(db);
  const { seedIfEmpty } = await import("./seed");
  const fresh = await seedIfEmpty(db);
  if (fresh && process.env.BAYPOOK_DEMO_SAMPLE !== "0") {
    const { seedDemoBookings } = await import("./demo-data");
    await seedDemoBookings(db).catch((e) => console.warn("[baypook] sample bookings skipped:", e));
  }
  return db;
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  g.__baypookPglite = client;
  return drizzle(client, { schema }) as unknown as Db;
}

async function migratePglite(db: Db): Promise<void> {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  // The migrator is typed for PgliteDatabase; our Db is the structural superset.
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * A throwaway in-memory database for tests: migrated, optionally seeded.
 * Each call is independent.
 */
export async function createTestDb(opts: { seed?: boolean } = {}): Promise<Db> {
  const db = await openPglite(undefined);
  await migratePglite(db);
  if (opts.seed) {
    const { seed } = await import("./seed");
    await seed(db);
  }
  return db;
}

/** Apply migrations to a live Postgres (used by scripts, not at request time). */
export async function migrateLive(db: Db): Promise<void> {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
}
