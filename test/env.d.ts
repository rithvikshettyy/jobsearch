declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		/** Test-only binding, injected by vitest.config.mts. */
		TEST_MIGRATIONS: D1Migration[];
	}
}
