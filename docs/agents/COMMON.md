# Common brief for BayPook subagents

You are one of several agents building BayPook in `C:\Users\salma\Documents\Projects\baypook` (Windows; Git Bash available; use forward slashes). Read these first, fully:
- `docs/spec/BAYPOOK-BUILD-PROMPT.md` (the build prompt) and `docs/spec/BAYPOOK-REQUIREMENTS.md` (the spec)
- `src/db/schema.ts` (the schema: do NOT change it; if you truly need a column, finish without it and report the exact change you want in your final message)
- `src/db/index.ts` (`getDb()`, `createTestDb({ seed: true })`, types `Db`, `Tx`, `DbOrTx`), `src/db/seed.ts`
- `src/core/time.ts`, `src/core/timetable.ts`, `src/server/sessions.ts`, `src/server/org.ts`
- `src/providers/types.ts`, `src/providers/index.ts`, `src/lib/env.ts`
- `docs/API.md` (the public API contract), `DECISIONS.md`

Rules:
- Only create or edit the files you own (listed in your brief). Never edit files owned by another agent or by the director (schema, migrations, `STATE.md`, `package.json`, configs). If you need something from another module, code against the contract in your brief; if it does not exist yet, create a minimal typed stub ONLY inside your own files.
- Do not `git commit` or `git push`. The director commits.
- TypeScript strict, no `any` outside third-party adapter boundaries, `npm run typecheck` and `npm run lint` must pass for your files. Run `npx vitest run <your test files>` for your tests. Run the whole `npm run check` before you finish and fix what is yours.
- Money in integer pence. Store UTC `Date`s; evaluate rules in the organisation timezone with helpers from `src/core/time.ts`. Overlap is half-open: `start < otherEnd && end > otherStart`.
- British English in all copy. "Grown-ups" not "adults". Warm, short, plain words. No exclamation marks in headings, no emojis.
- Nothing hard-codes Slimedom: venue, prices, copy, colours, policies come from the database.
- Drizzle: `import * as s from "@/db/schema"`, `db.select().from(s.table)`; relational queries via `db.query.*` also work. Both PGlite (demo/tests) and Postgres must run every query: use only standard SQL.
- Tests: Vitest, under `tests/unit/...` (pure) or with `createTestDb` (DB). The config is `vitest.config.mts`.
- When done, reply with: files created/changed, how to run your tests, anything you could not finish, and any contract deviation.
