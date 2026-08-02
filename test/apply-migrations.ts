import { applyD1Migrations, env } from "cloudflare:test";

// The pool gives each test file an empty D1. Anything that reads a table —
// /health, runTick — needs the schema in place first.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
