#!/usr/bin/env node
// Starts BayPook in demo mode on port 3100: embedded database, seeded Slimedom, fake payments and email.
import { spawn } from "node:child_process";

const port = process.env.PORT || "3100";
const env = { ...process.env, BAYPOOK_MODE: "demo", PORT: port, BAYPOOK_URL: `http://localhost:${port}` };
const args = process.argv.includes("--prod") ? ["next", "start", "-p", port] : ["next", "dev", "-p", port];

console.log(`\nBayPook demo starting on http://localhost:${port}  (admin: /admin, booking page: /book)\n`);
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
