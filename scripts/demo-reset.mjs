#!/usr/bin/env node
// Deletes the demo database so the next `npm run demo` starts from a fresh seed.
import { rmSync } from "node:fs";
import path from "node:path";
const dir = path.resolve(process.cwd(), process.env.BAYPOOK_DEMO_DIR || ".data/demo");
rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}. Run npm run demo to reseed.`);
