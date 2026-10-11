import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Three clearly separated test suites:
 *   unit        - pure logic, no I/O                         (npm test)
 *   integration - API routes + server code with a MOCKED Supabase client (npm test)
 *                 These prove our code's behaviour, NOT Supabase/RLS security.
 *   db          - real PostgreSQL + migrations 0001-0004 + Supabase shim (npm run test:db)
 *                 Proves constraints, triggers, grants and RLS on Postgres; not hosted Supabase.
 */
export default defineConfig({
  // tsconfig keeps `jsx: "preserve"` for Next.js; tests that render components need Vite to
  // compile JSX itself (React automatic runtime). Affects tests only, not the Next build.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside React Server Components; tests import server modules directly.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { extends: true, test: { name: "integration", include: ["tests/integration/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
