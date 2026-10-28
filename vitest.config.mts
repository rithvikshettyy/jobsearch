import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Read once at config time so every isolate gets the same statements. The
// binding is test-only — nothing in src/ ever sees it.
const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
	test: {
		// x-scraper is a Python project with its own virtualenv; vitest has no business scanning it.
		exclude: ["**/node_modules/**", "**/dist/**", "x-scraper/**"],
		setupFiles: ["./test/apply-migrations.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// TELEGRAM_CHAT_ID is a secret in production, so tests get a dummy one.
					bindings: { TEST_MIGRATIONS: migrations, TELEGRAM_CHAT_ID: "-1001234567890" },
				},
			},
		},
	},
});
