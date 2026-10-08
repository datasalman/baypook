/**
 * Seed a live database and/or make an email the owner.
 *
 *   DATABASE_URL=… BAYPOOK_MODE=live npx tsx scripts/seed.ts --owner you@slimedom.com
 *
 * Seeds Slimedom's organisation, venues and catalogue when the database is empty,
 * then upserts the owner user. Safe to run again.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, migrateLive } from "../src/db";
import * as s from "../src/db/schema";
import { seedIfEmpty } from "../src/db/seed";
import { isDemo } from "../src/lib/env";

async function main() {
  const args = process.argv.slice(2);
  const ownerIdx = args.indexOf("--owner");
  const ownerEmail = ownerIdx >= 0 ? args[ownerIdx + 1]?.trim().toLowerCase() : undefined;

  const db = await getDb();
  if (!isDemo()) await migrateLive(db);
  const seeded = await seedIfEmpty(db);
  console.log(seeded ? "Seeded Slimedom organisation, venues and catalogue." : "Database already seeded; left as is.");

  if (ownerEmail) {
    const [existing] = await db.select().from(s.users).where(eq(s.users.email, ownerEmail));
    if (existing) {
      await db.update(s.users).set({ isOwner: true, active: true, updatedAt: new Date() }).where(eq(s.users.id, existing.id));
      console.log(`${ownerEmail} is now an owner.`);
    } else {
      await db.insert(s.users).values({ email: ownerEmail, name: ownerEmail.split("@")[0], isOwner: true });
      console.log(`Created owner ${ownerEmail}. Sign in at /login with a magic link.`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
