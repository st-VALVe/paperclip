#!/usr/bin/env node
// Preflight for the authenticated multi-user throwaway test.
// See doc/runbooks/authenticated-multi-user-live-test.md.
//
// Aborts (exit 1) if any source that server startup loads could route the
// throwaway instance at a NON-throwaway database. Startup reads, in order:
//   - process.env DATABASE_URL / DATABASE_MIGRATION_URL / PAPERCLIP_CONFIG
//     (packages/db/src/runtime-config.ts) — cleared by the runbook's shell step;
//   - the env file next to the resolved config, then process.cwd()/.env, via
//     dotenv with override:false (server/src/config.ts) — a cwd `.env` can
//     therefore re-fill a cleared var;
//   - an ancestor `.paperclip/config.json` when PAPERCLIP_CONFIG is unset
//     (server/src/paths.ts).
// Migrations run against the resolved DB before the banner prints
// (server/src/index.ts), so a banner check alone is not enough.
//
// The cwd `.env` is parsed with the SAME dotenv the server resolves (from
// ./server), so this check cannot drift from real load semantics: it handles
// `=`, `: ` (colon+space), `export `, quoting, comments, and empty values
// exactly as startup does.
//
// Run from the directory you will start the server in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const DB_KEYS = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_CONFIG"];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the server's own dotenv (resolved from ./server relative to this script,
// not from cwd) so parsing matches startup exactly. Fail closed if it cannot be
// found: without it we cannot prove the .env is safe, and the server needs it
// installed to run anyway.
let dotenv;
try {
  dotenv = require(
    require.resolve("dotenv", {
      paths: [path.join(scriptDir, "..", "server"), path.join(scriptDir, "..")],
    }),
  );
} catch {
  console.error(
    "ABORT - cannot resolve dotenv to check .env with real load semantics.\n" +
      "Run `pnpm install` first (the server needs it too), then re-run this preflight.",
  );
  process.exit(1);
}

const problems = [];

// Parse cwd/.env with the server's dotenv so "would this set the var?" is
// identical to startup. A var is a problem only if dotenv yields a non-empty
// value (an empty value does not override anything at runtime).
const cwdEnv = path.resolve(".env");
if (fs.existsSync(cwdEnv)) {
  const parsed = dotenv.parse(fs.readFileSync(cwdEnv, "utf8"));
  const hits = DB_KEYS.filter((key) => parsed[key] !== undefined && parsed[key] !== "");
  if (hits.length > 0) {
    problems.push(`${cwdEnv} sets ${hits.join(", ")} (dotenv loads this at startup)`);
  }
}

// An ancestor `.paperclip/config.json` is used when PAPERCLIP_CONFIG is unset.
let dir = process.cwd();
for (;;) {
  const cfg = path.join(dir, ".paperclip", "config.json");
  if (fs.existsSync(cfg)) {
    problems.push(`${cfg} (ancestor config; used when PAPERCLIP_CONFIG is unset)`);
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

if (problems.length > 0) {
  console.error("ABORT - these could route the throwaway at a non-throwaway DB:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nRemediation: blank/move those DB vars in the repo .env, or remove/relocate the ancestor config, then re-run this preflight.",
  );
  process.exit(1);
}
console.log("preflight OK - no cwd .env DB vars and no ancestor .paperclip/config.json");
