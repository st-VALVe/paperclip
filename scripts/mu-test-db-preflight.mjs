#!/usr/bin/env node
// Preflight for the authenticated multi-user throwaway test.
// See doc/runbooks/authenticated-multi-user-live-test.md.
//
// Aborts (exit 1) if any source that server startup loads could route the
// throwaway instance at a NON-throwaway database. Startup reads, in order:
//   - process.env DATABASE_URL / DATABASE_MIGRATION_URL / PAPERCLIP_CONFIG
//     (packages/db/src/runtime-config.ts) — cleared by the runbook's shell step;
//   - the env file next to the resolved config, then process.cwd()/.env, via
//     dotenv with override:false (server/src/config.ts:33-44) — a cwd `.env`
//     can therefore re-fill a cleared var, including `export KEY=...`;
//   - an ancestor `.paperclip/config.json` when PAPERCLIP_CONFIG is unset
//     (server/src/paths.ts:28).
// Migrations run against the resolved DB before the banner prints
// (server/src/index.ts:316), so a banner check alone is not enough.
//
// Run from the directory you will start the server in.
import fs from "node:fs";
import path from "node:path";

const DB_KEYS = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_CONFIG"];
const problems = [];

// dotenv-compatible: optional `export `, optional whitespace around `=`, and a
// non-empty value (an empty value trims to "" and is ignored by the loaders).
function envKeysWithValue(text) {
  return DB_KEYS.filter((key) =>
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(?:"[^"]|'[^']|[^'"\\s#])`, "m").test(text),
  );
}

const cwdEnv = path.resolve(".env");
if (fs.existsSync(cwdEnv)) {
  const hits = envKeysWithValue(fs.readFileSync(cwdEnv, "utf8"));
  if (hits.length > 0) {
    problems.push(`${cwdEnv} sets ${hits.join(", ")} (dotenv loads this at startup)`);
  }
}

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
  console.error("ABORT — these could route the throwaway at a non-throwaway DB:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nRemediation: blank/move those DB vars in the repo .env, or remove/relocate the ancestor config, then re-run this preflight.",
  );
  process.exit(1);
}
console.log("preflight OK - no cwd .env DB vars and no ancestor .paperclip/config.json");
