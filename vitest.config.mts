import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Read once at config time so every isolate gets the same statements. The
// binding is test-only — nothing in src/ ever sees it.
const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
				},
			},
		},
	},
});
